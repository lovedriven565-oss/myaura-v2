import { Router } from 'express';
import { getDb } from './db.js';
import { aiProvider } from './ai.js';
import { storage } from './storage.js';
import { deliverTelegramResults, deliverTelegramPhoto, sendTelegramStatus } from './telegram.js';
import { refundCredit } from './dbQueue.js';
import { buildFreePrompt, buildPremiumPrompt } from './prompts.js';
import type { StyleId } from './prompts.js';
import { evaluateAuditGate, mergeProfile, type SubjectProfile } from './biometric.js';

export const workerRouter = Router();

// Middleware to verify Cloud Tasks OIDC token (if needed)
function verifyCloudTasksToken(req: any, res: any, next: any) {
  // Add actual OIDC token verification here if deployed securely
  next();
}

workerRouter.post('/generate', verifyCloudTasksToken, async (req, res) => {
  const { generationId, userId, mode, profile: taskProfile } = req.body;
  const db = getDb();

  try {
    // 1. Идемпотентность (Блокировка дублей)
    // Atomic update to lock the job
    const { data: jobs, error: lockError } = await db
      .from('generations')
      .update({ status: 'processing_audit' }) // intermediate status
      .eq('id', generationId)
      .eq('status', 'processing')
      .select('*');

    if (lockError || !jobs || jobs.length === 0) {
      console.log(`[Worker] Task ${generationId} already processed or invalid state`);
      return res.status(200).send('Already processed or invalid state');
    }

    const job = jobs[0];
    const sourcePaths: string[] = job.reference_paths || [job.original_path].filter(Boolean);
    const styleIds: string[] = job.style_ids || [job.prompt_preset].filter(Boolean);
    
    // Load metadata and format URIs using storage interface
    const auditRefs = [];
    for (const path of sourcePaths) {
        const meta = await storage.headObject(path);
        if (meta.exists && meta.contentType) {
            // Read buffer from R2, convert to base64 for Gemini
            const buffer = await storage.get(path);
            if (buffer) {
                auditRefs.push({ base64: buffer.toString('base64'), mimeType: meta.contentType });
            }
        }
    }

    if (auditRefs.length === 0) {
        throw new Error("No valid references found in Storage");
    }

    // Interim status update to Telegram
    const telegramChatId = job.telegram_chat_id || parseInt(userId, 10);
    sendTelegramStatus(telegramChatId, "Анализируем ваши фото...").catch(() => {});

    // Phase 3: Step 3.1 - Audit & Anchoring (Gemini 2.5 Flash)
    const auditTier = mode === 'premium' ? 'premium' : 'free';
    const audit = await aiProvider.auditReferences(auditRefs);
    
    // In V2 we can bypass audit errors if the user is an admin. Here we pass false for simplicity, 
    // but you can fetch user roles from DB if needed.
    const gate = evaluateAuditGate(audit, auditTier, false);
    
    if (!gate.pass) {
        // Refund and notify
        throw new Error(`PHOTO_QUALITY_REJECTED: ${gate.reason}`);
    }

    const profile: SubjectProfile = taskProfile && typeof taskProfile === 'object'
      ? taskProfile as SubjectProfile
      : mergeProfile(audit, "unset", "mature");

    // Update state to synthesis
    await db.from('generations').update({ status: 'processing_synthesis' }).eq('id', generationId);
    sendTelegramStatus(telegramChatId, "Создаём вашу уникальную ауру...").catch(() => {});

    const maxRefs = mode === 'premium' ? 14 : 1;
    // Map best indices back to GCS URIs
    const bestAuditRefs = audit.perImage
        .map((res, idx) => ({ res, ref: auditRefs[idx] }))
        .filter(({res}) => res.usable)
        .slice(0, maxRefs)
        .map(({ref}) => ref);

    if (bestAuditRefs.length === 0) {
        throw new Error("No usable references after audit filtering");
    }

    // Phase 3: Step 3.2 - Synthesis
    const outputCount = mode === 'premium' ? 7 : 1;
    const generatedUrls: string[] = [];

    // Schedule styles across the output count
    const scheduledStyles: StyleId[] = [];
    for (let i = 0; i < outputCount; i++) {
        scheduledStyles.push((styleIds[i % styleIds.length] || "business") as StyleId);
    }

    // Parallel synthesis for Premium, sequential for Free (to save resources)
    if (mode === 'premium') {
        sendTelegramStatus(telegramChatId, `Генерируем ${outputCount} фото параллельно...`).catch(() => {});
        
        const tasks = scheduledStyles.map(async (styleId, i) => {
            const prompt = buildPremiumPrompt(styleId, i, profile);
            const imageBase64 = await aiProvider.generatePremiumTier(bestAuditRefs, prompt, profile, styleId, i, generationId);
            
            const buffer = Buffer.from(imageBase64, 'base64');
            const resultUrl = await storage.save(buffer, `${generationId}_result_${i}.jpg`, "result");
            
            // Progressive notification (non-blocking)
            deliverTelegramPhoto(telegramChatId, resultUrl, `Готово: ${i + 1} из ${outputCount}`).catch(() => {});
            
            return resultUrl;
        });

        const results = await Promise.all(tasks);
        generatedUrls.push(...results);
        
        // Update DB once after all are done
        await db.from('generations').update({ 
            results_completed: outputCount,
            result_paths: generatedUrls
        }).eq('id', generationId);

    } else {
        // Free tier stays sequential
        for (let i = 0; i < outputCount; i++) {
            const styleId = scheduledStyles[i];
            const prompt = buildFreePrompt(styleId, i, profile);
            const imageBase64 = await aiProvider.generateFreeTier(bestAuditRefs, prompt);
            
            const buffer = Buffer.from(imageBase64, 'base64');
            const resultUrl = await storage.save(buffer, `${generationId}_result_${i}.jpg`, "result");
            generatedUrls.push(resultUrl);
            
            await db.from('generations').update({ 
                results_completed: i + 1,
                result_paths: generatedUrls
            }).eq('id', generationId);
        }
    }

    // Phase 4: Delivery & Garbage Collection
    await db.from('generations').update({ 
      status: 'completed', 
      result_path: generatedUrls[0], // primary
      results_completed: outputCount,
      result_paths: generatedUrls
    }).eq('id', generationId);

    // Notify Telegram
    await deliverTelegramResults(telegramChatId, generatedUrls, null, mode);

    // 4.4 GDPR Garbage Collection: мгновенное удаление оригиналов из Storage
    for (const path of sourcePaths) {
        await storage.delete(path);
    }

    return res.status(200).send('OK');

  } catch (error: any) {
    console.error(`[Worker] failed for ${generationId}:`, error);
    
    // Safely delete original files on fatal error
    if (error.status !== 429 && error.status < 500) {
        const { data: job } = await db.from('generations').select('reference_paths').eq('id', generationId).single();
        if (job?.reference_paths) {
            for (const path of job.reference_paths) {
                await storage.delete(path);
            }
        }
    }

    const isRetryable = error.status === 429 || error.status >= 500;
    
    if (!isRetryable) {
      await db.from('generations').update({ status: 'failed', error_message: error.message }).eq('id', generationId);
      
      const { data: job } = await db.from('generations').select('credit_type, telegram_user_id').eq('id', generationId).single();
      if (job?.credit_type && job?.telegram_user_id) {
        await refundCredit(job.telegram_user_id, job.credit_type, generationId, `Worker error: ${error.message}`);
        await sendTelegramStatus(job.telegram_user_id, `Произошла ошибка: ${error.message}. Твои кредиты возвращены.`).catch(() => {});
      }
    }
    
    return res.status(isRetryable ? 500 : 200).send(error.message);
  }
});

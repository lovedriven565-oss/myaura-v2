import { Router } from 'express';
import { getDb } from './db.js';
import { aiProvider } from './ai.js';
import { storage } from './storage.js';
import { deleteFromGcs, headGcsObject } from './gcs.js';
import { deliverTelegramResults, deliverTelegramPhoto, sendTelegramStatus } from './telegram.js';
import { refundCredit } from './dbQueue.js';
import { buildFreePrompt, buildPremiumPrompt } from './prompts.js';
import { evaluateAuditGate, mergeProfile, profileFromUserOnly } from './biometric.js';

export const workerRouter = Router();

// Middleware to verify Cloud Tasks OIDC token (if needed)
function verifyCloudTasksToken(req: any, res: any, next: any) {
  // Add actual OIDC token verification here if deployed securely
  next();
}

workerRouter.post('/generate', verifyCloudTasksToken, async (req, res) => {
  const { generationId, userId, mode } = req.body;
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
    
    // Load metadata and format GCS URIs
    const auditRefs = [];
    for (const path of sourcePaths) {
        const meta = await headGcsObject(path);
        if (meta.exists && meta.contentType) {
            auditRefs.push({ gcsUri: `gs://${process.env.INGESTION_BUCKET || 'myaura-ingestion'}/${path}`, mimeType: meta.contentType });
        }
    }

    if (auditRefs.length === 0) {
        throw new Error("No valid references found in GCS");
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

    const baseProfile = profileFromUserOnly("unset", "young"); // Ideally load from job context
    const profile = mergeProfile(audit, baseProfile.gender, baseProfile.ageTier);

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
    const styleId = styleIds[0] || "business";
    const prompt = mode === 'premium' 
      ? buildPremiumPrompt(styleId, 0, profile) 
      : buildFreePrompt(styleId as any, 0, profile);

    const generatedImageBase64 = mode === 'premium'
      ? await aiProvider.generatePremiumTier(bestAuditRefs, prompt, profile, styleId as any, 0, generationId)
      : await aiProvider.generateFreeTier(bestAuditRefs, prompt);

    // Convert Base64 back to buffer for R2 upload
    const generatedImageBuffer = Buffer.from(generatedImageBase64, 'base64');

    // Phase 4: Delivery & Garbage Collection
    const resultUrl = await storage.save(generatedImageBuffer, `${generationId}_result_final.jpg`, "result");

    await db.from('generations').update({ 
      status: 'completed', 
      result_path: resultUrl,
      results_completed: 1,
      result_paths: [resultUrl]
    }).eq('id', generationId);

    // Notify Telegram
    await deliverTelegramResults(telegramChatId, [resultUrl], null, mode);

    // 4.4 GDPR Garbage Collection: мгновенное удаление оригиналов из GCS
    await deleteFromGcs(sourcePaths);

    return res.status(200).send('OK');

  } catch (error: any) {
    console.error(`[Worker] failed for ${generationId}:`, error);
    
    // Safely delete original files on fatal error
    if (error.status !== 429 && error.status < 500) {
        const { data: job } = await db.from('generations').select('reference_paths').eq('id', generationId).single();
        if (job?.reference_paths) {
            await deleteFromGcs(job.reference_paths);
        }
    }

    const isRetryable = error.status === 429 || error.status >= 500;
    
    if (!isRetryable) {
      await db.from('generations').update({ status: 'failed', error_message: error.message }).eq('id', generationId);
      
      const { data: job } = await db.from('generations').select('credit_type, telegram_user_id').eq('id', generationId).single();
      if (job?.credit_type && job?.telegram_user_id) {
        await refundCredit(job.telegram_user_id, job.credit_type, generationId, `Worker error: ${error.message}`);
        await deliverTelegramPhoto(job.telegram_user_id, `Произошла ошибка: ${error.message}. Твои кредиты возвращены.`, "").catch(() => {});
      }
    }
    
    return res.status(isRetryable ? 500 : 200).send(error.message);
  }
});

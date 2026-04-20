import { Telegraf, Markup } from "telegraf";
import { storage } from "./storage.js";
import { getDb } from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { buildPrompt, StyleId } from "./prompts.js";
import { PACKAGES, buildStyleSchedule, runBatched } from "./packages.js";
import { aiProvider } from "./ai.js";

let botInstance: Telegraf | null = null;

export function getBotInstance(): Telegraf | null {
  return botInstance;
}

export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set. Telegram bot will not be started.");
    return;
  }

  const bot = new Telegraf(token);
  botInstance = bot;

  bot.start((ctx) => {
    const webAppUrl = process.env.APP_URL || "https://myaura.by";
    ctx.reply(
      "Привет! 👋 Я — нейросеть MyAURA. Я превращаю обычные селфи в профессиональные портреты, крутые арты и стильные аватарки.\n\nЗапустите приложение ниже, чтобы получить бесплатные генерации и выбрать свой уникальный стиль!",
      Markup.inlineKeyboard([
        Markup.button.webApp("✨ Открыть MyAURA", webAppUrl)
      ])
    );
  });

  bot.help((ctx) => {
    const webAppUrl = process.env.APP_URL || "https://myaura.by";
    ctx.reply(
      "Чтобы создать нейро-фото, просто запустите приложение по кнопке ниже или отправьте мне селфи прямо в этот чат!",
      Markup.inlineKeyboard([
        Markup.button.webApp("✨ Открыть MyAURA", webAppUrl)
      ])
    );
  });

  bot.on("text", (ctx) => {
    const webAppUrl = process.env.APP_URL || "https://myaura.by";
    ctx.reply(
      "Чтобы создать нейро-фото, просто запустите приложение по кнопке ниже или отправьте мне селфи прямо в этот чат!",
      Markup.inlineKeyboard([
        Markup.button.webApp("✨ Открыть MyAURA", webAppUrl)
      ])
    );
  });

  bot.on("photo", async (ctx) => {
    try {
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      const fileId = largestPhoto.file_id;
      const userId = ctx.from.id.toString();
      const webAppUrl = process.env.APP_URL || "https://myaura.by";

      // Deduplication guard: if user already has a generation started in the last 90s,
      // skip creating a new one to prevent the double-result perceived duplication.
      const db = getDb();
      if (db) {
        const cutoff = new Date(Date.now() - 90_000).toISOString();
        const { data: recent } = await db
          .from("generations")
          .select("id, status")
          .eq("user_id", userId)
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(1);
        if (recent && recent.length > 0) {
          await ctx.reply(
            "⏳ Ваша генерация уже обрабатывается! Откройте приложение, чтобы посмотреть результат.",
            Markup.inlineKeyboard([Markup.button.webApp("✨ Открыть MyAURA", webAppUrl)])
          );
          return;
        }
      }

      const fileUrl = await ctx.telegram.getFileLink(fileId);
      
      const processingMsg = await ctx.reply("✨ Фото получено! Запускаю бесплатную тестовую генерацию. Пожалуйста, подождите немного...");

      // Download photo
      const response = await fetch(fileUrl.toString());
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = "image/jpeg";
      
      // Save original
      const originalName = `tg_${fileId}.jpg`;
      const originalPath = await storage.save(buffer, originalName, "original");

      const preset = "business"; // Default preset for direct upload
      const { prompt } = buildPrompt("free", preset as StyleId);
      
      const base64Image = buffer.toString("base64");
      const resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt, 'preview');
      const resultBuffer = Buffer.from(resultBase64, "base64");
      const resultPath = await storage.save(resultBuffer, "result.jpg", "result");

      if (db) {
        const id = uuidv4();
        const expiresAt = new Date(Date.now() + 1440 * 60000).toISOString();
        await db.from("generations").insert({
          id,
          user_id: userId,
          type: "free",
          status: "completed",
          original_path: originalPath,
          result_path: resultPath,
          prompt_preset: preset,
          expires_at: expiresAt
        });
      }

      const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
      const resultUrl = `${publicBaseUrl}/${resultPath}`;

      await ctx.replyWithPhoto(
        { url: resultUrl }, 
        { 
          caption: "Готово! 🎨\n\nХотите выбрать другой стиль или получить фото в максимальном Premium-качестве? Запускайте приложение!",
          ...Markup.inlineKeyboard([
            Markup.button.webApp("✨ Открыть MyAURA", webAppUrl)
          ])
        }
      );
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

    } catch (error: any) {
      console.error("Telegram processing error:", error);
      ctx.reply("Ой, произошла ошибка при создании фото. Попробуйте еще раз или зайдите в приложение.");
    }
  });

  // ─── Telegram Stars Payment Webhooks ────────────────────────────────
  bot.on("pre_checkout_query", async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (error) {
      console.error("pre_checkout_query error:", error);
      await ctx.answerPreCheckoutQuery(false, "Ошибка проверки. Попробуйте позже.");
    }
  });

  bot.on("successful_payment", async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const payload = payment.invoice_payload;
      const [userIdStr, packageId] = payload.split("_");
      const telegramId = parseInt(userIdStr, 10);

      const PACKAGE_REWARDS: Record<string, number> = {
        starter: 7,
        pro: 25,
        max: 60,
      };

      const amountToAdd = PACKAGE_REWARDS[packageId] || 0;

      const db = getDb();
      if (!db) {
        console.error("DB not available for payment processing");
        return;
      }

      // Idempotency check: use telegram_payment_charge_id if available, fallback to payload
      const chargeId = payment.telegram_payment_charge_id || payload;
      const { error: insertError } = await db.from("processed_payments").insert({
        charge_id: chargeId,
        payload: payload,
        telegram_id: telegramId,
        package_id: packageId,
        amount_xtr: payment.total_amount,
      });

      if (insertError) {
        if (insertError.code === "23505") {
          console.log(`[Idempotency] Payment charge_id=${chargeId} already processed. Skipping.`);
          return;
        }
        throw insertError;
      }

      // Add paid_credits atomically
      const { error: updateError } = await db.rpc("add_paid_credits", {
        p_telegram_id: telegramId,
        p_amount: amountToAdd,
      });

      if (updateError) throw updateError;

      await ctx.reply(`✅ Оплата прошла!\nВам начислено +${amountToAdd} генераций. Приятного использования!`);
      console.log(`Payment OK: user=${telegramId}, pkg=${packageId}, +${amountToAdd} credits`);
    } catch (error) {
      console.error("Error processing successful_payment:", error);
    }
  });

  // Webhook mode: no bot.launch() polling — messages handled via POST /api/webhook/telegram
  console.log("Telegram bot initialized (webhook mode, no polling).");
}

/**
 * Sends a text status update to the user.
 */
export async function sendTelegramStatus(chatId: number, message: string): Promise<number | null> {
  if (!botInstance) return null;
  try {
    const msg = await botInstance.telegram.sendMessage(chatId, message);
    return msg.message_id;
  } catch (err: any) {
    console.error(`[Telegram] sendTelegramStatus failed:`, err.message);
    return null;
  }
}

/**
 * Deletes a Telegram message by ID.
 */
export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  if (!botInstance) return;
  try {
    await botInstance.telegram.deleteMessage(chatId, messageId);
  } catch (err: any) {
    console.error(`[Telegram] deleteTelegramMessage failed:`, err.message);
  }
}

/**
 * Sends a Telegram notification to a referrer when their referral award is granted.
 */
export async function notifyReferralAwarded(telegramId: number): Promise<void> {
  if (!botInstance) {
    console.warn("[Referral] Telegram notify skipped: bot not initialized");
    return;
  }
  try {
    await botInstance.telegram.sendMessage(
      telegramId,
      "🎉 Твой друг активировал MyAURA — тебе начислена 1 бесплатная генерация!"
    );
    console.log(`[Referral] Notified referrer telegramId=${telegramId}`);
  } catch (err: any) {
    console.error(`[Referral] sendMessage failed for telegramId=${telegramId}:`, err.message);
  }
}

/**
 * Delivers a single photo progressively during generation.
 * Called as each image completes, so user sees results immediately.
 */
export async function deliverTelegramPhoto(chatId: number, resultPath: string, caption?: string) {
  console.log(`deliverTelegramPhoto called: chatId=${chatId}, resultPath=${resultPath}`);
  if (!botInstance) {
    console.warn("Telegram delivery skipped: bot not initialized");
    return;
  }
  try {
    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
    const url = `${publicBaseUrl}/${resultPath}`;
    console.log(`Sending photo to Telegram: chatId=${chatId}, url=${url}`);
    await botInstance.telegram.sendPhoto(chatId, url, { caption });
    console.log(`Successfully sent photo to Telegram chat ${chatId}`);
  } catch (error) {
    console.error(`Failed to deliver progressive photo to Telegram chat ${chatId}:`, error);
  }
}

/**
 * Builds an inline keyboard for referral sharing.
 * Uses `switch_inline_query` so Telegram opens its native share picker.
 */
function buildReferralKeyboard(referralCode: string) {
  const botUsername =
    process.env.BOT_USERNAME ||
    process.env.VITE_BOT_USERNAME ||
    "Myaura_neirobot";
  const shareMessage =
    `✨ Попробуй MyAURA — нейросеть превращает селфи в профессиональные портреты. ` +
    `По моей ссылке тебе дадут бесплатную генерацию: ` +
    `https://t.me/${botUsername}?start=ref_${referralCode}`;
  return {
    inline_keyboard: [[
      { text: "🎁 Пригласить друга (+1 фото)", switch_inline_query: shareMessage },
    ]],
  };
}

/**
 * Delivers generated results back to a Telegram chat (batch).
 * Used as fallback or for final delivery summary.
 */
export async function deliverTelegramResults(
  chatId: number,
  resultPaths: string[],
  referralCode?: string | null,
  tier: "free" | "premium" = "free",
) {
  console.log(`Attempting Telegram delivery to chat ${chatId}, ${resultPaths.length} image(s), tier=${tier}`);
  if (!botInstance) { console.warn("Telegram delivery skipped: bot not initialized"); return; }
  if (resultPaths.length === 0) { console.warn("Telegram delivery skipped: no result paths"); return; }

  // Build share-a-friend inline keyboard (referral B-lite)
  const referralKeyboard = referralCode ? buildReferralKeyboard(referralCode) : undefined;

  try {
    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";

    // For single output (free)
    if (resultPaths.length === 1) {
      const url = `${publicBaseUrl}/${resultPaths[0]}`;
      const caption = tier === "free"
        ? "Ваш нейро-портрет готов! ✨\n\n💎 В Premium HD — нейросеть нового поколения: кинематографическая детализация, 100% сохранение черт лица и эксклюзивные стили (Cyberpunk, Corporate, Ethereal)."
        : "Ваш нейро-портрет готов! ✨";
      await botInstance.telegram.sendPhoto(chatId, url, {
        caption,
        ...(referralKeyboard ? { reply_markup: referralKeyboard } : {}),
      });
      return;
    }
    
    // For multiple outputs (starter, signature, premium)
    // Telegram restricts media groups to 10 items max. We must chunk them.
    const MAX_GROUP_SIZE = 10;
    
    for (let i = 0; i < resultPaths.length; i += MAX_GROUP_SIZE) {
      const chunk = resultPaths.slice(i, i + MAX_GROUP_SIZE);
      const mediaGroup = chunk.map((path, index) => {
        const url = `${publicBaseUrl}/${path}`;
        const caption = (i === 0 && index === 0) ? "Ваши премиум-портреты готовы! ✨" : undefined;
        return {
          type: 'photo' as const,
          media: url,
          caption
        };
      });
      
      console.log(`Sending media group chunk ${i / MAX_GROUP_SIZE + 1}: ${chunk.length} photos to chat ${chatId}`);
      try {
        await botInstance.telegram.sendMediaGroup(chatId, mediaGroup);
        console.log(`Media group chunk ${i / MAX_GROUP_SIZE + 1} sent successfully`);
      } catch (groupErr: any) {
        console.error(`sendMediaGroup failed for chunk ${i / MAX_GROUP_SIZE + 1}, chatId=${chatId}: ${groupErr.message}`);
        // Fallback: send each photo individually
        console.log(`Falling back to individual sendPhoto for ${chunk.length} photos`);
        for (const path of chunk) {
          try {
            const url = `${publicBaseUrl}/${path}`;
            await botInstance.telegram.sendPhoto(chatId, url);
          } catch (singleErr: any) {
            console.error(`Individual sendPhoto failed for ${path}: ${singleErr.message}`);
          }
        }
      }
    }

    // Follow-up message with referral share button (media groups don't support reply_markup)
    if (referralKeyboard) {
      try {
        await botInstance.telegram.sendMessage(
          chatId,
          "Поделитесь MyAURA с друзьями и получите +1 бесплатную генерацию за каждого, кто активирует аккаунт 🎁",
          { reply_markup: referralKeyboard },
        );
      } catch (inviteErr: any) {
        console.error(`[Referral] follow-up invite button failed for chat ${chatId}: ${inviteErr.message}`);
      }
    }
  } catch (error) {
    console.error(`Failed to deliver results to Telegram chat ${chatId}:`, error);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V6.0 — Telegram Bot & Delivery Layer
// ═════════════════════════════════════════════════════════════════════════════
//
// Responsibility boundary:
//   - bot.start / bot.help / bot.on("text")  → direct users to the Mini App
//   - bot.on("photo")                        → instruct users to use the Mini App
//     (no bypass-generation path: would skip credits / rate-limits / quality
//     gate, which is an abuse vector)
//   - Payment webhook events (pre_checkout_query, successful_payment) are
//     handled by the canonical HTTP webhook in routes.ts::telegramWebhookHandler
//     which is mounted at POST /api/webhook/telegram. Duplicate handlers on
//     the bot instance are DELETED — they had the wrong add_paid_credits
//     signature and would silently fail on every real payment.
//
// Exports:
//   initTelegramBot()           — set up bot with direct-to-Mini-App routing
//   getBotInstance()            — used by invoice creation / webhook
//   sendTelegramStatus()        — interim progress notifications
//   deleteTelegramMessage()     — clean up status messages
//   notifyReferralAwarded()     — referral bonus notifier
//   deliverTelegramPhoto()      — progressive per-photo delivery
//   deliverTelegramResults()    — batch / final delivery with share CTA
// ═════════════════════════════════════════════════════════════════════════════

import { Telegraf, Markup } from "telegraf";

let botInstance: Telegraf | null = null;

export function getBotInstance(): Telegraf | null {
  return botInstance;
}

function webAppUrl(): string {
  return process.env.APP_URL || "https://myaura.by";
}

function openAppKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.webApp("✨ Открыть MyAURA", webAppUrl()),
  ]);
}

export function initTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN is not set. Bot will not be started.");
    return;
  }

  const bot = new Telegraf(token);
  botInstance = bot;

  bot.start(ctx => {
    ctx.reply(
      "Привет! 👋 Я — нейросеть MyAURA. Я превращаю обычные селфи в " +
      "профессиональные портреты, крутые арты и стильные аватарки.\n\n" +
      "Запустите приложение ниже, чтобы получить бесплатные генерации " +
      "и выбрать свой уникальный стиль!",
      openAppKeyboard(),
    ).catch(err => console.error("[Telegram] start reply failed:", err?.message || err));
  });

  bot.help(ctx => {
    ctx.reply(
      "Чтобы создать нейро-фото, откройте приложение по кнопке ниже.",
      openAppKeyboard(),
    ).catch(err => console.error("[Telegram] help reply failed:", err?.message || err));
  });

  // Text messages & photos both route the user to the Mini App — we never
  // run a generation pipeline from a DM because that would bypass the
  // credit/rate-limit/auth layer.
  bot.on("text", ctx => {
    ctx.reply(
      "Чтобы создать нейро-фото, откройте приложение по кнопке ниже.",
      openAppKeyboard(),
    ).catch(err => console.error("[Telegram] text reply failed:", err?.message || err));
  });

  bot.on("photo", ctx => {
    ctx.reply(
      "Спасибо за фото! ✨ Чтобы запустить генерацию, откройте приложение " +
      "и загрузите ваши селфи там — это подтянет баланс, подберёт лучший " +
      "стиль и сохранит результаты в вашем аккаунте.",
      openAppKeyboard(),
    ).catch(err => console.error("[Telegram] photo reply failed:", err?.message || err));
  });

  // NOTE: Payment events are handled exclusively by routes.ts telegramWebhookHandler
  // (mounted at POST /api/webhook/telegram). No duplicate handlers here.

  console.log("[Telegram] Bot initialised (webhook mode, no polling).");
}

// ─── Messaging helpers ─────────────────────────────────────────────────────

/** Send a text status update. Returns the message_id so callers can delete later. */
export async function sendTelegramStatus(chatId: number, message: string): Promise<number | null> {
  if (!botInstance) return null;
  try {
    const msg = await botInstance.telegram.sendMessage(chatId, message);
    return msg.message_id;
  } catch (err: any) {
    console.error(`[Telegram] sendTelegramStatus failed: ${err?.message || err}`);
    return null;
  }
}

export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  if (!botInstance) return;
  try {
    await botInstance.telegram.deleteMessage(chatId, messageId);
  } catch (err: any) {
    console.error(`[Telegram] deleteTelegramMessage failed: ${err?.message || err}`);
  }
}

export async function notifyReferralAwarded(telegramId: number): Promise<void> {
  if (!botInstance) {
    console.warn("[Referral] Telegram notify skipped: bot not initialized");
    return;
  }
  try {
    await botInstance.telegram.sendMessage(
      telegramId,
      "🎉 Твой друг активировал MyAURA — тебе начислена 1 бесплатная генерация!",
    );
  } catch (err: any) {
    console.error(`[Referral] sendMessage failed for telegramId=${telegramId}: ${err?.message || err}`);
  }
}

// ─── Photo delivery ────────────────────────────────────────────────────────

/**
 * Deliver a single result photo during generation (progressive stream).
 * Free tier delivers the single output via deliverTelegramResults at the end
 * to avoid double-sending.
 */
export async function deliverTelegramPhoto(
  chatId: number,
  resultPath: string,
  caption?: string,
): Promise<void> {
  if (!botInstance) {
    console.warn("[Telegram] delivery skipped: bot not initialized");
    return;
  }
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
  const url = `${publicBaseUrl}/${resultPath}`;
  try {
    await botInstance.telegram.sendPhoto(chatId, url, caption ? { caption } : undefined);
  } catch (err: any) {
    console.error(`[Telegram] deliverTelegramPhoto failed for chat=${chatId}: ${err?.message || err}`);
  }
}

function buildReferralKeyboard(referralCode: string) {
  const botUsername =
    process.env.BOT_USERNAME || process.env.VITE_BOT_USERNAME || "Myaura_neirobot";
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
 * Deliver the final pack of generated photos, chunked to respect Telegram's
 * 10-item media-group cap. Falls back to individual sendPhoto on group errors.
 * Appends a share CTA message when a referral code is available.
 */
export async function deliverTelegramResults(
  chatId: number,
  resultPaths: string[],
  referralCode?: string | null,
  tier: "free" | "premium" = "free",
): Promise<void> {
  if (!botInstance) {
    console.warn("[Telegram] delivery skipped: bot not initialized");
    return;
  }
  if (resultPaths.length === 0) {
    console.warn("[Telegram] delivery skipped: no result paths");
    return;
  }

  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
  const referralKeyboard = referralCode ? buildReferralKeyboard(referralCode) : undefined;

  // Single-photo delivery (free tier)
  if (resultPaths.length === 1) {
    const url = `${publicBaseUrl}/${resultPaths[0]}`;
    const caption = tier === "free"
      ? "Ваш нейро-портрет готов! ✨\n\n💎 В Premium HD — нейросеть нового поколения: " +
        "кинематографическая детализация, 100% сохранение черт лица и эксклюзивные стили " +
        "(Cyberpunk, Corporate, Ethereal)."
      : "Ваш нейро-портрет готов! ✨";
    try {
      await botInstance.telegram.sendPhoto(chatId, url, {
        caption,
        ...(referralKeyboard ? { reply_markup: referralKeyboard } : {}),
      });
    } catch (err: any) {
      console.error(`[Telegram] single-photo delivery failed for chat=${chatId}: ${err?.message || err}`);
    }
    return;
  }

  // Batch delivery — Telegram caps media groups at 10 items.
  const MAX_GROUP_SIZE = 10;
  for (let i = 0; i < resultPaths.length; i += MAX_GROUP_SIZE) {
    const chunk = resultPaths.slice(i, i + MAX_GROUP_SIZE);
    const mediaGroup = chunk.map((path, index) => ({
      type: "photo" as const,
      media: `${publicBaseUrl}/${path}`,
      caption: (i === 0 && index === 0) ? "Ваши премиум-портреты готовы! ✨" : undefined,
    }));

    try {
      await botInstance.telegram.sendMediaGroup(chatId, mediaGroup);
    } catch (groupErr: any) {
      console.error(
        `[Telegram] sendMediaGroup failed for chunk ${i / MAX_GROUP_SIZE + 1} ` +
        `chat=${chatId}: ${groupErr?.message || groupErr}. Falling back to individual sendPhoto.`,
      );
      for (const path of chunk) {
        try {
          await botInstance.telegram.sendPhoto(chatId, `${publicBaseUrl}/${path}`);
        } catch (singleErr: any) {
          console.error(`[Telegram] individual sendPhoto failed for ${path}: ${singleErr?.message || singleErr}`);
        }
      }
    }
  }

  // Share CTA (media groups don't support reply_markup, so we send a follow-up).
  if (referralKeyboard) {
    try {
      await botInstance.telegram.sendMessage(
        chatId,
        "Поделитесь MyAURA с друзьями и получите +1 бесплатную генерацию за каждого, кто активирует аккаунт 🎁",
        { reply_markup: referralKeyboard },
      );
    } catch (inviteErr: any) {
      console.error(`[Referral] share CTA failed for chat=${chatId}: ${inviteErr?.message || inviteErr}`);
    }
  }
}

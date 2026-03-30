import { Telegraf, Markup } from "telegraf";
import { aiProvider } from "./ai.js";
import { storage } from "./storage.js";
import { getDb } from "./db.js";
import { v4 as uuidv4 } from "uuid";

export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set. Telegram bot will not be started.");
    return;
  }

  const bot = new Telegraf(token);

  bot.start((ctx) => {
    const webAppUrl = process.env.APP_URL || "https://myaura.by";
    ctx.reply(
      "Welcome to MyAURA! You can upload a photo here or use our Mini App.",
      Markup.inlineKeyboard([
        Markup.button.webApp("Open Mini App", webAppUrl)
      ])
    );
  });

  bot.help((ctx) => {
    ctx.reply("Send me a photo and I will generate a beautiful portrait for you! Or open the Mini App for more options.");
  });

  bot.on("photo", async (ctx) => {
    try {
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      const fileId = largestPhoto.file_id;
      
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      
      const processingMsg = await ctx.reply("Processing your photo...");

      // Download photo
      const response = await fetch(fileUrl.toString());
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = "image/jpeg";
      
      // Save original
      const originalName = `tg_${fileId}.jpg`;
      const originalPath = await storage.save(buffer, originalName, "original");

      const preset = "business"; // Default preset for direct upload
      const prompt = "Create a professional business headshot, high-end studio lighting, sharp suit, confident expression, neutral background.";
      
      const base64Image = buffer.toString("base64");
      const resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt);
      const resultBuffer = Buffer.from(resultBase64, "base64");
      const resultPath = await storage.save(resultBuffer, "result.jpg", "result");

      const db = getDb();
      if (db) {
        const id = uuidv4();
        const userId = ctx.from.id.toString();
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

      await ctx.replyWithPhoto({ url: resultUrl }, { caption: "Here is your generated portrait!" });
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

    } catch (error: any) {
      console.error("Telegram processing error:", error);
      ctx.reply("Sorry, there was an error processing your photo. Please try again later.");
    }
  });

  bot.launch().then(() => {
    console.log("Telegram bot started.");
  }).catch((err) => {
    console.error("Failed to start Telegram bot:", err);
  });

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

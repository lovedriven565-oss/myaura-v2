import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { initDb } from "./src/server/db.js";
import { startRetentionCron } from "./src/server/retention.js";
import { apiRouter, telegramWebhookHandler } from "./src/server/routes.js";
import { initTelegramBot } from "./src/server/telegram.js";
import { startWatchdogCron } from "./src/server/watchdog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Allowed CORS origins — add custom origins via CORS_ORIGINS="https://a.com,https://b.com"
function buildCorsOrigins(): (string | RegExp)[] {
  const fromEnv = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const defaults = [
    "https://myaura.by",
    "https://www.myaura.by",
    /^https:\/\/t\.me$/,
    /^https:\/\/web\.telegram\.org$/,
  ];
  return [...defaults, ...fromEnv];
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const isProd = process.env.NODE_ENV === "production";

  // Security headers. CSP is disabled in dev to avoid interfering with Vite HMR;
  // in production Telegram WebView enforces its own constraints, so we keep
  // things permissive for images/XHR but lock down classic vectors.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  // CORS: in production restrict to known origins; in dev allow all.
  app.use(
    cors({
      origin: isProd ? buildCorsOrigins() : true,
      credentials: false,
    })
  );

  // JSON body limit — increased to 50mb for image uploads (FormData with photos)
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Initialize DB, Storage and Telegram Bot (fail-fast on misconfig)
  initDb();
  startRetentionCron();
  startWatchdogCron();
  if (process.env.ENABLE_TELEGRAM_BOT !== "false") {
    initTelegramBot();
  }

  // Lightweight health endpoint for deploy checks
  app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Telegram webhook - mounted DIRECTLY on app (before apiRouter) to avoid auth middleware
  // Uses express.raw() to get raw body for secret token verification if needed
  app.post("/api/webhook/telegram", 
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res, next) => {
      // Parse raw body back to JSON for the handler
      try {
        if (req.body && Buffer.isBuffer(req.body)) {
          (req as any).body = JSON.parse(req.body.toString());
        }
      } catch (e) {
        console.warn('[Webhook] Failed to parse body as JSON:', e);
      }
      next();
    },
    telegramWebhookHandler
  );

  // API Routes
  app.use("/api", apiRouter);

  // API 404 handler — MUST come before the SPA catch-all, otherwise unknown
  // /api/* paths in production fall through to index.html and the client
  // receives HTML where it expects JSON ("Unexpected token '<'").
  app.use("/api", (req, res) => {
    console.log(`[404 API] ${req.method} ${req.path} not found`);
    res.status(404).json({ error: "API endpoint not found", path: req.path, code: "NOT_FOUND" });
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // server.js is in dist/, client files live alongside it.
    const distPath = __dirname;
    // Hashed assets: safe to cache long-term (immutable). index.html: never cache.
    app.use(
      "/assets",
      express.static(path.join(distPath, "assets"), {
        maxAge: "1y",
        immutable: true,
      })
    );
    app.use(express.static(distPath, { index: false }));
    app.get("*", (req, res) => {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global Error Handler (JSON responses). Leaks only the top-level message
  // in production — stack/details stay in server logs.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Express Error:", err?.stack || err?.message || err);
    const status = err?.status || 500;
    res.status(status).json({
      error: isProd && status >= 500 ? "Internal Server Error" : err?.message || "Internal Server Error",
      code: err?.code || "INTERNAL_ERROR",
    });
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} (NODE_ENV=${process.env.NODE_ENV || "dev"})`);
  });

  // Graceful shutdown — let in-flight requests finish.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.warn("Forced shutdown after 10s grace period.");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

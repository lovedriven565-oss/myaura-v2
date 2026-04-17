# MyAURA Cloud Run Dockerfile
# Multi-stage build: builds the app inside container, no pre-built dist required

# ─── Stage 1: Dependencies ───────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

# ─── Stage 2: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Copy dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build frontend (Vite) and server (esbuild)
RUN npm run build

# ─── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

# Create non-root user for security
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

# Copy only necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Cloud Run requires the container to listen on $PORT
ENV PORT=3000
ENV NODE_ENV=production

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=2 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/healthz', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Run the server
CMD ["node", "dist/server.js"]

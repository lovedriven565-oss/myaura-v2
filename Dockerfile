# MyAURA Cloud Run Dockerfile
# Minimal, production-ready container for Google Cloud Run

FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application
# Note: dist/ must be built before docker build (npm run build)
COPY dist/ ./dist/
COPY keys/ ./keys/

# Cloud Run requires the container to listen on $PORT
# Default to 3000 for local testing
ENV PORT=3000
ENV NODE_ENV=production

# Expose port (Cloud Run ignores this, but good for documentation)
EXPOSE 3000

# Health check (Cloud Run uses /healthz endpoint)
# This is informational; Cloud Run's health checking is external
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=2 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/healthz', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Run the server
# Use node directly — no PM2 required for Cloud Run
CMD ["node", "dist/server.js"]

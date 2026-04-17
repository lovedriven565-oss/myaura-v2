# MyAURA Cloud Run Deployment Guide

Fast deployment to Google Cloud Run (serverless containers).

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI)
- Docker (for local build testing)
- Access to a Google Cloud project with Cloud Run API enabled

## 1. Environment Variables (Required)

Copy these from your current VPS `.env`. Cloud Run injects env vars at runtime.

### Critical for Cloud Run:
```bash
# Server (Cloud Run sets PORT automatically)
NODE_ENV=production

# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# AI / Vertex AI
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
VERTEX_LOCATION=global
VERTEX_AI_MODEL_FREE=gemini-3.1-flash-image-preview
VERTEX_AI_MODEL_PREMIUM=gemini-3-pro-image-preview

# Storage (R2 or GCS)
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-key
R2_SECRET_ACCESS_KEY=your-secret
R2_BUCKET_NAME=your-bucket
R2_PUBLIC_BASE_URL=https://your-cdn.com

# Telegram Bot
BOT_TOKEN=your-bot-token
WEBHOOK_DOMAIN=https://your-service-url.a.run.app
ENABLE_TELEGRAM_BOT=true

# Optional: Quality Gate
JUDGE_MODEL_ID=gemini-3.1-flash-image-preview
QUALITY_GATE_ENABLED=true
```

## 2. Build and Deploy

### Option A: Local Build + Push (Recommended for first deploy)

```bash
# Build frontend and server
npm run build

# Set your GCP project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com

# Build and push container
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/myaura:latest

# Deploy to Cloud Run
gcloud run deploy myaura \
  --image gcr.io/YOUR_PROJECT_ID/myaura:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 80 \
  --max-instances 10 \
  --min-instances 1 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "SUPABASE_URL=https://..." \
  --set-env-vars "SUPABASE_ANON_KEY=..." \
  --set-env-vars "SUPABASE_SERVICE_ROLE_KEY=..." \
  # Add all other env vars...
```

### Option B: Cloud Build (Build in GCP)

```bash
# Deploy directly from source (Cloud Build builds the container)
gcloud run deploy myaura \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2
```

## 3. Verify Deployment

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe myaura --region us-central1 --format 'value(status.url)')

# Check health
curl $SERVICE_URL/healthz
# Expected: {"ok":true,"ts":1234567890}

# Check main page
curl -I $SERVICE_URL
```

## 4. Update Telegram Webhook

After first deploy, update your bot webhook:

```bash
# Set webhook to Cloud Run URL
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=${SERVICE_URL}/webhook"
```

## 5. Continuous Deployment

### Using Cloud Build Triggers (GitHub integration):

1. Connect GitHub repo in Cloud Build console
2. Create trigger on push to `main`
3. Use `cloudbuild.yaml` (optional, see below)

### Manual re-deploy (quick updates):

```bash
# Build and deploy in one command
gcloud run deploy myaura \
  --image gcr.io/YOUR_PROJECT_ID/myaura:latest \
  --region us-central1
```

## Cloud Run vs VPS: What's Different

| Feature | VPS (PM2) | Cloud Run |
|---------|-----------|-----------|
| Process manager | PM2 | Cloud Run (built-in) |
| Port | Fixed (3000) | `process.env.PORT` (set by Cloud Run) |
| Scaling | Manual | Auto (0-N instances) |
| Health checks | Manual | `/healthz` endpoint |
| SSL | Certbot | Automatic |
| Domain | Your domain | `*.a.run.app` or custom |
| Filesystem | Persistent | Ephemeral (use R2/GCS) |

## Troubleshooting

### Container fails to start
```bash
# Check logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=myaura" --limit=50
```

### Health check fails
- Ensure `/healthz` returns `{"ok":true}` (already implemented)
- Verify container listens on `0.0.0.0` (already implemented in server.ts)

### Out of memory
- Increase `--memory` flag (try `4Gi` for heavy AI workloads)

### Cold starts
- Use `--min-instances 1` to keep one instance warm

## Optional: cloudbuild.yaml

```yaml
steps:
  - name: 'gcr.io/cloud-builders/npm'
    args: ['ci']
  - name: 'gcr.io/cloud-builders/npm'
    args: ['run', 'build']
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/myaura:$COMMIT_SHA', '.']
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/myaura:$COMMIT_SHA']
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'deploy'
      - 'myaura'
      - '--image'
      - 'gcr.io/$PROJECT_ID/myaura:$COMMIT_SHA'
      - '--region'
      - 'us-central1'
      - '--platform'
      - 'managed'
      - '--allow-unauthenticated'

images:
  - 'gcr.io/$PROJECT_ID/myaura:$COMMIT_SHA'
```

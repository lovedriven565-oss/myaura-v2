# Vertex AI on Cloud Run — IAM & env setup

This is the exact configuration the `myaura-server` Cloud Run service needs
to call Vertex AI (`@google/genai` with `vertexai: true`) **without** an API key.
It documents the fix for the "IAM denied → 24h ADC cooldown" incident.

---

## 1. Enable required APIs

Run once per GCP project (or in Cloud Console → APIs & Services → Enable):

```bash
gcloud services enable aiplatform.googleapis.com   --project="$GOOGLE_PROJECT_ID"
gcloud services enable run.googleapis.com          --project="$GOOGLE_PROJECT_ID"
```

`aiplatform.googleapis.com` is **required** — without it every request returns
`PERMISSION_DENIED` even with the right roles.

---

## 2. IAM roles for the Cloud Run service account

Find the service account the Cloud Run revision runs as:

Cloud Console → Cloud Run → `myaura-server` → **Security** tab → "Service account".
It usually looks like `myaura-server@<project>.iam.gserviceaccount.com` or
`<project-number>-compute@developer.gserviceaccount.com`.

Grant it **one** role:

| Role | ID | Why |
|------|-----|-----|
| **Vertex AI User** | `roles/aiplatform.user` | Allows calling `projects/*/locations/*/publishers/google/models/*:generateContent`. This is the minimum scope for our workload. |

### Command-line (preferred — auditable)

```bash
export PROJECT_ID="your-gcp-project"
export SA_EMAIL="myaura-server@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user"
```

### If the service account lives in a different project than Vertex AI

Add **`roles/serviceusage.serviceUsageConsumer`** on the Vertex project:

```bash
gcloud projects add-iam-policy-binding "$VERTEX_PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/serviceusage.serviceUsageConsumer"
```

(Only needed for cross-project setups. Our default is same-project and does
not need this.)

---

## 3. Environment variables on Cloud Run

Set these on the `myaura-server` service (Cloud Run → Edit & Deploy New Revision
→ Variables & Secrets):

| Env var | Required | Value | Purpose |
|---------|----------|-------|---------|
| `USE_VERTEX_AI` | **Yes** | `true` | Selects `VertexAIProvider` over the AI Studio provider. |
| `GOOGLE_PROJECT_ID` | **Yes** | `your-gcp-project` | Explicit quota/billing project for Vertex AI calls. ADC does not always carry one — leaving this blank is exactly what caused the original 403 misclassified as "key exhausted". |
| `VERTEX_AI_LOCATION` | **Yes** | `europe-west1` | Region. Must match where you have model access. `europe-west1` is the current production choice (same region as Cloud Run). |
| `VERTEX_AI_MODEL_FREE` | Optional | `gemini-3.1-flash-image-preview` | Override the free-tier model id. |
| `VERTEX_AI_MODEL_PREMIUM` | Optional | `gemini-3-pro-image-preview` | Override the premium-tier model id. |

**Do not set** `GOOGLE_APPLICATION_CREDENTIALS` on Cloud Run. ADC is the path —
Cloud Run auto-mints tokens for the revision's service account via the metadata
server.

**Do not set** `GEMINI_API_KEY` when `USE_VERTEX_AI=true`. Vertex AI does not
accept API keys; supplying one only risks the wrong provider being chosen.

---

## 4. Verification

After applying the above, check Cloud Run logs after the next deploy. You want
to see this near the top of boot:

```
[KeyPool] Scanning /srv/keys... (vertex location=europe-west1, adc_project=your-gcp-project)
[KeyPool] keys folder does not exist — using ADC slot
```

Then, on the first real generation:

```
[KeyPool] Using key ...adc | 1/1 ready
[Stage1] [Tier: FREE] Trying gemini-3.1-flash-image-preview (global) | key ...adc
[Stage1] SUCCESS | [Tier: FREE] ...
```

### If you see `[IAM FATAL] ... on ADC slot — refusing to cool down`

That's the new safety net. It means either:

1. `roles/aiplatform.user` is not actually on the Cloud Run service account.
   Re-run the `gcloud projects add-iam-policy-binding` above and verify with:
   ```bash
   gcloud projects get-iam-policy "$PROJECT_ID" \
     --flatten="bindings[].members" \
     --format='table(bindings.role)' \
     --filter="bindings.members:${SA_EMAIL}"
   ```
2. `aiplatform.googleapis.com` is not enabled.
3. `GOOGLE_PROJECT_ID` does not match the project where Vertex AI access was
   granted.

Fix the underlying cause and redeploy — no cooldown to wait out.

---

## 5. Why we don't use a Gemini API key (`AIza...`)

- Regional restriction: Gemini API (AI Studio) is not available in Belarus.
  Users there would get `USER_LOCATION_INVALID`.
- Vertex AI is bound to a specific GCP region (`europe-west1` here) and serves
  those regions regardless of end-user location.
- Vertex AI uses IAM tokens (short-lived, auto-rotated by Cloud Run) instead
  of a long-lived API key — fewer secrets to manage and rotate.

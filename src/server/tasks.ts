import { CloudTasksClient } from "@google-cloud/tasks";

const client = new CloudTasksClient();

const PROJECT_ID = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
const LOCATION_ID = process.env.CLOUD_TASKS_LOCATION || "us-central1";
const QUEUE_ID = process.env.CLOUD_TASKS_QUEUE || "generation-queue";
const WORKER_URL = process.env.WORKER_URL || "https://myaura-worker-url.run.app/api/worker/generate";
const SERVICE_ACCOUNT_EMAIL = process.env.CLOUD_TASKS_SA_EMAIL || "";

export async function enqueueGenerationTask(generationId: string, userId: string, mode: "free" | "premium") {
  if (!PROJECT_ID) {
    console.warn("[CloudTasks] Missing PROJECT_ID. Skipping enqueue.");
    return;
  }

  const parent = client.queuePath(PROJECT_ID, LOCATION_ID, QUEUE_ID);

  const payload = {
    generationId,
    userId,
    mode,
  };

  const task: any = {
    httpRequest: {
      httpMethod: "POST",
      url: WORKER_URL,
      headers: {
        "Content-Type": "application/json",
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  };

  // Add OIDC auth to the request if a service account email is provided
  if (SERVICE_ACCOUNT_EMAIL) {
    task.httpRequest.oidcToken = {
      serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
    };
  }

  try {
    const [response] = await client.createTask({ parent, task });
    console.log(`[CloudTasks] Enqueued task ${response.name} for generation ${generationId}`);
    return response;
  } catch (error) {
    console.error(`[CloudTasks] Failed to enqueue task for ${generationId}:`, error);
    throw error;
  }
}

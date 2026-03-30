import cron from "node-cron";
import { getDb } from "./db.js";
import { storage } from "./storage.js";

export function startRetentionCron() {
  // Run every 15 minutes to clean up expired files
  cron.schedule("*/15 * * * *", async () => {
    console.log("Running retention cleanup job...");
    const db = getDb();
    
    try {
      const { data: rows, error } = await db
        .from("generations")
        .select("id, original_path, result_path")
        .lte("expires_at", new Date().toISOString());

      if (error) {
        console.error("Error fetching expired generations:", error);
        return;
      }

      for (const row of rows || []) {
        try {
          if (row.original_path) {
            await storage.delete(row.original_path);
          }
          if (row.result_path) {
            await storage.delete(row.result_path);
          }
          
          await db.from("generations").delete().eq("id", row.id);
          console.log(`Cleaned up generation ${row.id}`);
        } catch (e) {
          console.error(`Failed to clean up generation ${row.id}:`, e);
        }
      }
    } catch (err) {
      console.error("Retention cron error:", err);
    }
  });
}

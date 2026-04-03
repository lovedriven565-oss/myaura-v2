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
        .select("id, original_path, result_path, reference_paths, result_paths")
        .lte("expires_at", new Date().toISOString());

      if (error) {
        console.error("Error fetching expired generations:", error);
        return;
      }

      for (const row of rows || []) {
        try {
          // Delete legacy paths
          if (row.original_path) {
            await storage.delete(row.original_path);
          }
          if (row.result_path) {
            await storage.delete(row.result_path);
          }
          
          // Delete new array paths
          if (Array.isArray(row.reference_paths)) {
            for (const path of row.reference_paths) {
              // Avoid double deleting if it matches the legacy path
              if (path !== row.original_path) {
                await storage.delete(path);
              }
            }
          }
          
          if (Array.isArray(row.result_paths)) {
            for (const path of row.result_paths) {
              if (path !== row.result_path) {
                await storage.delete(path);
              }
            }
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

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Database row types for the 'generations' table
export interface GenerationRow {
  id: string;
  user_id: string;
  type: "free" | "premium"; // Legacy field
  package_id: "free" | "starter" | "signature" | "premium";
  status: "processing" | "completed" | "failed" | "partial";
  original_path: string | null; // Legacy field
  reference_paths: string[]; // New array format
  result_path: string | null; // Legacy field
  result_paths: string[]; // New array format
  prompt_preset: string | null; // Legacy field
  style_ids: string[]; // New array format
  results_completed: number;
  results_failed: number;
  results_total: number;
  error_message: string | null;
  expires_at: string; // ISO timestamp
  telegram_chat_id: number | null;
  created_at?: string;
  updated_at?: string;
  
  // V9.0 Vertex AI Subject Tuning Fields
  tuning_job_id?: string | null;
  tuning_status?: 'pending' | 'running' | 'succeeded' | 'failed' | null;
  tuned_model_resource_name?: string | null;
}

let supabase: SupabaseClient;

export function initDb() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn("Supabase credentials not fully provided. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    return;
  }

  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("Connected to Supabase.");
}

export function getDb() {
  if (!supabase) {
    throw new Error("Database not initialized");
  }
  return supabase;
}

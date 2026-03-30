import { createClient, SupabaseClient } from "@supabase/supabase-js";

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

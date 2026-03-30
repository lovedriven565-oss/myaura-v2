-- Create generations table
CREATE TABLE IF NOT EXISTS generations (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('free', 'premium')),
    status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
    original_path TEXT,
    result_path TEXT,
    prompt_preset TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Create index for faster expiration cleanup
CREATE INDEX IF NOT EXISTS idx_generations_expires_at ON generations(expires_at);

-- Set up Row Level Security (RLS)
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;

-- Create policies
-- Allow service role to do everything (backend operations)
CREATE POLICY "Service role has full access" ON generations
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Allow users to read their own generations (if you implement client-side auth later)
-- CREATE POLICY "Users can read own generations" ON generations
--     FOR SELECT
--     USING (auth.uid()::text = user_id);

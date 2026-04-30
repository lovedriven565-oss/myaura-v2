-- Migration to add Vertex AI Subject Tuning fields to generations table

ALTER TABLE public.generations 
ADD COLUMN tuning_job_id text,
ADD COLUMN tuning_status text, -- e.g., 'pending', 'running', 'succeeded', 'failed'
ADD COLUMN tuned_model_resource_name text;

-- Add index on tuning_job_id for faster polling lookups
CREATE INDEX idx_generations_tuning_job_id ON public.generations(tuning_job_id);

-- Add index on tuning_status to quickly find jobs that need polling
CREATE INDEX idx_generations_tuning_status ON public.generations(tuning_status) WHERE tuning_status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dealers (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policies (
  id SERIAL PRIMARY KEY,
  version INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  policy_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'processing', 'done', 'failed')),
  last_photo_at TIMESTAMPTZ,
  trigger_run_id TEXT,
  start_task_id TEXT,
  summary_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_dealer_status ON jobs(dealer_id, status);

CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  seq_num INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  preview_path TEXT,
  hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  analysis_json JSONB,
  edit_instruction TEXT,
  edit_output_path TEXT,
  check_json JSONB,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  final_decision TEXT,
  note TEXT,
  step_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_run_id TEXT,
  total_latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_images_job_seq ON images(job_id, seq_num);
CREATE INDEX IF NOT EXISTS idx_images_dealer_hash ON images(dealer_id, hash);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  image_id UUID REFERENCES images(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('dealer', 'assistant', 'system')),
  msg_type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT NOT NULL DEFAULT 'sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_dealer_id ON messages(dealer_id, id);

CREATE TABLE IF NOT EXISTS trace_events (
  id BIGSERIAL PRIMARY KEY,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  image_id UUID REFERENCES images(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_dealer_id ON trace_events(dealer_id, id);
CREATE INDEX IF NOT EXISTS idx_trace_job_id ON trace_events(job_id, id);

CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  dealer_id UUID REFERENCES dealers(id) ON DELETE SET NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  image_id UUID REFERENCES images(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  problems_repaired JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

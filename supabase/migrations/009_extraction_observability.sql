create table if not exists public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  run_no integer not null default 1,
  ai_mode text,
  model_name text,
  prompt_version text,
  status text not null default 'started' check (status in ('started', 'completed', 'failed')),
  llm_attempts integer not null default 0,
  llm_applied integer not null default 0,
  duration_ms integer,
  error_message text,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(document_id, run_no)
);

create table if not exists public.extraction_field_reviews (
  id uuid primary key default gen_random_uuid(),
  document_item_id uuid not null references public.document_items(id) on delete cascade,
  field_name text not null,
  old_value text,
  new_value text,
  reason text,
  reviewed_by text,
  reviewed_at timestamptz not null default now()
);

create index if not exists extraction_field_reviews_item_idx
  on public.extraction_field_reviews(document_item_id);

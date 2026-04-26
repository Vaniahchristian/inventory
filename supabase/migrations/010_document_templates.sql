create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('sales_order', 'container_manifest')),
  template_fingerprint text not null,
  sample_file_name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1,
  notes text,
  unique(document_type, template_fingerprint)
);

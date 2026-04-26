create table if not exists public.product_import_audit (
  id bigserial primary key,
  source_file_name text,
  source_file_type text,
  client_details text,
  container_no text,
  ai_mode text not null,
  llm_attempts integer not null default 0,
  llm_aligned integer not null default 0,
  totals_match boolean not null default false,
  totals_diff jsonb,
  validation_flag_counts jsonb,
  sample_rows jsonb,
  created_at timestamptz not null default now()
);

create index if not exists product_import_audit_created_at_idx
  on public.product_import_audit(created_at desc);

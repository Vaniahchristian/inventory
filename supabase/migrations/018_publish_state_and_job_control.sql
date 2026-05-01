alter table public.documents
  add column if not exists publish_state text not null default 'staged'
    check (publish_state in ('staged', 'published')),
  add column if not exists published_at timestamptz,
  add column if not exists published_by text;

create index if not exists documents_publish_state_idx
  on public.documents(publish_state, extraction_status, created_at desc);

alter table public.import_jobs
  add column if not exists idempotency_key text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists retry_at timestamptz;

create unique index if not exists import_jobs_idempotency_uidx
  on public.import_jobs(idempotency_key)
  where idempotency_key is not null;

create index if not exists import_jobs_retry_status_idx
  on public.import_jobs(status, retry_at, updated_at desc);

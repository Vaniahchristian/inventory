create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued',
  step text not null default 'queued',
  progress_pct integer not null default 0,
  file_url text not null,
  file_name text not null,
  skip_db_insert boolean not null default false,
  doc_type text null,
  rows_extracted integer null,
  rows_pass integer null,
  rows_flagged integer null,
  totals_match boolean null,
  document_id text null,
  result jsonb null,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.import_jobs
  add column if not exists step text not null default 'queued',
  add column if not exists progress_pct integer not null default 0,
  add column if not exists file_url text,
  add column if not exists file_name text,
  add column if not exists skip_db_insert boolean not null default false,
  add column if not exists doc_type text,
  add column if not exists rows_extracted integer,
  add column if not exists rows_pass integer,
  add column if not exists rows_flagged integer,
  add column if not exists totals_match boolean,
  add column if not exists document_id text,
  add column if not exists result jsonb,
  add column if not exists error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists import_jobs_status_updated_idx
  on public.import_jobs(status, updated_at desc);

create index if not exists import_jobs_file_name_created_idx
  on public.import_jobs(file_name, created_at desc);

alter table public.import_jobs enable row level security;

drop policy if exists "Allow all import_jobs" on public.import_jobs;
create policy "Allow all import_jobs" on public.import_jobs
for all using (true) with check (true);

create or replace function public.set_updated_at_import_jobs()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists import_jobs_set_updated_at on public.import_jobs;
create trigger import_jobs_set_updated_at
before update on public.import_jobs
for each row execute function public.set_updated_at_import_jobs();

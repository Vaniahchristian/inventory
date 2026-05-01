alter table public.import_jobs
  drop constraint if exists import_jobs_status_check;

alter table public.import_jobs
  add constraint import_jobs_status_check
  check (status in ('queued', 'processing', 'retryable', 'completed', 'failed'));

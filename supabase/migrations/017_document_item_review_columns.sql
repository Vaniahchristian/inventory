alter table public.document_items
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending', 'accepted', 'rejected')),
  add column if not exists review_note text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists model_source text default 'claude',
  add column if not exists rerun_count integer not null default 0;

create index if not exists document_items_review_status_idx
  on public.document_items(document_id, review_status, line_no);

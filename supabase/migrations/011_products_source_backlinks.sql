alter table public.products
  add column if not exists source_document_id uuid references public.documents(id) on delete set null,
  add column if not exists source_document_item_id uuid references public.document_items(id) on delete set null,
  add column if not exists extraction_confidence integer check (extraction_confidence between 0 and 100),
  add column if not exists extraction_flags jsonb default '[]'::jsonb;

create index if not exists products_source_document_idx
  on public.products(source_document_id);

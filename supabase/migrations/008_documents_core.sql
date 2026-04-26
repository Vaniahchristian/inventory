create extension if not exists pgcrypto;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('sales_order', 'container_manifest')),
  source_file_name text not null,
  source_file_path text,
  source_file_sha256 text,
  doc_number text,
  client_id text,
  client_name text,
  document_date date,
  container_no text,
  currency text default 'RMB',
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'processing', 'review_needed', 'approved', 'failed')),
  extraction_confidence integer not null default 0 check (extraction_confidence between 0 and 100),
  parser_version text,
  model_name text,
  validation_flags jsonb not null default '{}'::jsonb,
  raw_extraction jsonb,
  normalized_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_type_date_idx
  on public.documents(document_type, document_date desc);
create index if not exists documents_client_idx
  on public.documents(client_id, document_date desc);
create index if not exists documents_status_idx
  on public.documents(extraction_status, created_at desc);
create unique index if not exists documents_file_hash_uidx
  on public.documents(source_file_sha256)
  where source_file_sha256 is not null;

create table if not exists public.document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  line_no integer not null,
  item_code text,
  description text,
  shop text,
  packaging text,
  qty_per_carton numeric,
  total_cartons numeric,
  total_quantity numeric,
  unit_price_rmb numeric(14,2),
  total_amount_rmb numeric(16,2),
  dim_l_cm numeric(10,2),
  dim_w_cm numeric(10,2),
  dim_h_cm numeric(10,2),
  unit_cbm numeric(12,6),
  total_cbm numeric(12,6),
  unit_weight_kg numeric(12,4),
  total_weight_kg numeric(12,4),
  warehouse text,
  barcode text,
  remarks text,
  extraction_confidence integer not null default 0 check (extraction_confidence between 0 and 100),
  source_page integer,
  validation_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(document_id, line_no)
);

create index if not exists document_items_doc_idx
  on public.document_items(document_id);
create index if not exists document_items_item_code_idx
  on public.document_items(item_code);
create index if not exists document_items_shop_idx
  on public.document_items(shop);

create table if not exists public.document_totals (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references public.documents(id) on delete cascade,
  total_cartons numeric,
  total_quantity numeric,
  total_cbm numeric,
  total_weight_kg numeric,
  total_amount_rmb numeric(16,2),
  total_amount_usd numeric(16,2),
  computed_cartons numeric,
  computed_quantity numeric,
  computed_cbm numeric,
  computed_weight_kg numeric,
  computed_amount_rmb numeric(16,2),
  totals_match boolean not null default false,
  totals_diff jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_payments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  payment_date date,
  amount_usd numeric(14,2),
  amount_rmb numeric(14,2),
  payment_type text check (payment_type in ('deposit', 'balance', 'freight', 'credit', 'other')),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists document_payments_doc_idx
  on public.document_payments(document_id, payment_date);

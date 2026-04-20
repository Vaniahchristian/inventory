create table if not exists public.product_import_meta (
  id integer primary key,
  source_file_name text not null,
  source_file_type text not null check (source_file_type in ('pdf', 'excel_or_csv')),
  client_details text,
  container_no text,
  total_weight_kgs numeric,
  total_cbm numeric,
  total_carton numeric,
  total_cost_rmb numeric,
  total_cost_usd numeric,
  goods_balance_usd numeric,
  total_balance_usd numeric,
  exchange_rate numeric,
  updated_at timestamp with time zone not null default now()
);

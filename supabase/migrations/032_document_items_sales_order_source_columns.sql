-- Dedicated PDF columns for 义乌-style sales orders (DEL NO, CUS NO, ITEM NO, unit, 品名, 材质) + optional cell snapshot.
-- source_item_no exists from 014_sales_order_field_normalization.

alter table public.document_items
  add column if not exists delivery_no text,
  add column if not exists customer_item_ref text,
  add column if not exists unit text,
  add column if not exists product_name_local text,
  add column if not exists material text,
  add column if not exists source_cells jsonb not null default '{}'::jsonb;

comment on column public.document_items.delivery_no is 'PDF DEL NO / 送货单号 (batch reference)';
comment on column public.document_items.customer_item_ref is 'PDF CUS NO / 客户货号';
comment on column public.document_items.unit is 'PDF UNIT / 单位 (e.g. PCS)';
comment on column public.document_items.product_name_local is 'PDF ITEM 品名 column';
comment on column public.document_items.material is 'PDF MATERIAL / 材质';
comment on column public.document_items.source_cells is 'Optional keyed snapshot of raw header→cell text for audit/debug';

create index if not exists document_items_delivery_no_idx
  on public.document_items (document_id)
  where delivery_no is not null;

create index if not exists document_items_source_item_no_idx
  on public.document_items (document_id)
  where source_item_no is not null;

-- Sales-order normalization fields from source headers:
-- 送货地址, ORD NO., CUS NO., ITEM NO., PHOTO, PHOTO2, CODE, REK, W.H., L/W/H

alter table public.documents
  add column if not exists delivery_address text,
  add column if not exists order_no text,
  add column if not exists customer_no text;

alter table public.document_items
  add column if not exists source_item_no text,
  add column if not exists photo text,
  add column if not exists photo2 text,
  add column if not exists code text;

alter table public.products
  add column if not exists source_item_no text,
  add column if not exists photo text,
  add column if not exists photo2 text,
  add column if not exists code text,
  add column if not exists warehouse text,
  add column if not exists remarks text,
  add column if not exists barcode text,
  add column if not exists dim_l_cm numeric,
  add column if not exists dim_w_cm numeric,
  add column if not exists dim_h_cm numeric,
  add column if not exists order_no text,
  add column if not exists customer_no text,
  add column if not exists delivery_address text,
  add column if not exists document_date date;

create index if not exists products_order_no_idx on public.products(order_no);
create index if not exists products_customer_no_idx on public.products(customer_no);

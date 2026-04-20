ALTER TABLE public.product_import_meta
  ADD COLUMN IF NOT EXISTS payment_date text,
  ADD COLUMN IF NOT EXISTS payment_usd numeric,
  ADD COLUMN IF NOT EXISTS credit_support_usd numeric,
  ADD COLUMN IF NOT EXISTS pivoc_usd numeric,
  ADD COLUMN IF NOT EXISTS freight_usd numeric;

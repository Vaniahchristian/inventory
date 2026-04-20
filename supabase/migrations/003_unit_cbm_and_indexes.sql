-- ─────────────────────────────────────────────────────────────────────────────
-- 003_unit_cbm_and_indexes.sql
--
-- Align migrations with the current live schema:
--   • Add products.unit_cbm (already present in production, but missing from
--     migrations so fresh environments drift).
--   • Auto-maintain it: unit_cbm = cbm / cartons, kept in sync by a trigger so
--     neither the app nor CSV/XLSX/PDF imports have to compute it.
--   • Backfill existing rows.
--   • Add lookup indexes for the columns the UI filters on.
--
-- Safe to run multiple times (all statements are idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Column (no-op if it already exists)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS unit_cbm numeric;

-- 2. Trigger function: derive unit_cbm from cbm and cartons
CREATE OR REPLACE FUNCTION compute_products_unit_cbm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cartons IS NOT NULL
     AND NEW.cartons > 0
     AND NEW.cbm IS NOT NULL
  THEN
    NEW.unit_cbm := ROUND(NEW.cbm / NEW.cartons, 6);
  ELSE
    NEW.unit_cbm := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Bind the trigger: fires on every INSERT and on UPDATEs that touch cbm or
--    cartons (manual overrides to unit_cbm alone are respected).
DROP TRIGGER IF EXISTS products_compute_unit_cbm ON products;
CREATE TRIGGER products_compute_unit_cbm
  BEFORE INSERT OR UPDATE OF cbm, cartons ON products
  FOR EACH ROW EXECUTE FUNCTION compute_products_unit_cbm();

-- 4. Backfill rows that existed before the trigger
UPDATE products
SET    unit_cbm = ROUND(cbm / cartons, 6)
WHERE  cartons IS NOT NULL
  AND  cartons > 0
  AND  cbm IS NOT NULL
  AND  (unit_cbm IS NULL OR unit_cbm <> ROUND(cbm / cartons, 6));

-- 5. Lookup indexes used by the UI and by joins
CREATE INDEX IF NOT EXISTS products_shop_name_idx        ON products(shop_name);
CREATE INDEX IF NOT EXISTS products_category_id_idx      ON products(category_id);
CREATE INDEX IF NOT EXISTS products_supplier_id_idx      ON products(supplier_id);
CREATE INDEX IF NOT EXISTS products_sku_idx              ON products(sku);
CREATE INDEX IF NOT EXISTS stock_movements_product_id_idx  ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS stock_movements_created_at_idx  ON stock_movements(created_at DESC);

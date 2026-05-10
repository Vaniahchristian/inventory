-- Remove sales-order row normalizer and document_totals sync on document_items.
-- Logic is handled in application (reducto-html-parser, supabase-inserter, etc.).
-- document_totals sync trigger restored in 035_restore_document_totals_sync_trigger.sql.

drop trigger if exists trg_document_items_normalize_sales_outliers on public.document_items;
drop trigger if exists trg_document_items_sync_totals on public.document_items;

drop function if exists public.normalize_document_item_sales_outliers();
drop function if exists public.sync_document_totals_from_items();
drop function if exists public.safe_numeric_from_text(text);

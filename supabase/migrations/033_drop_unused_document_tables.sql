-- Unused in application code (no supabase.from(...) references). Safe to remove.
-- extraction_field_reviews: planned observability; never wired up (0 rows).
-- document_templates: fingerprint tracking; never wired up (0 rows).
-- categories + products.category_id: still referenced by schema — do not drop here.

drop table if exists public.extraction_field_reviews cascade;
drop table if exists public.document_templates cascade;

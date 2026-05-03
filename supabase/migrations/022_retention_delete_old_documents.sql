-- One-time data retention: remove documents (and cascaded line items, totals, payments, extraction_runs, etc.)
-- that are older than the start of “yesterday” in UTC.
-- Preserves: all of yesterday (00:00 UTC) through the end of today, and anything created today.
-- Compiled products: see migration 023 — source_document_id cascades on delete.

delete from public.documents
where created_at < (
  ((now() at time zone 'utc')::date - interval '1 day')::timestamp
  at time zone 'utc'
);

-- Fix 5: Add dedicated section column to document_items.
-- Eliminates the fragile "section:repacked" suffix encoded inside the remarks text.
-- Existing rows are backfilled by parsing the remarks encoding.

alter table public.document_items
  add column if not exists section text not null default 'shipped'
    check (section in ('shipped', 'left_in_warehouse', 'repacked'));

-- Backfill existing rows from the remarks encoding
update public.document_items
set section =
  case
    when remarks ilike '%section:repacked%' then 'repacked'
    when remarks ilike '%section:left_in_warehouse%' then 'left_in_warehouse'
    else 'shipped'
  end
where remarks is not null;

create index if not exists document_items_section_idx
  on public.document_items (document_id, section);

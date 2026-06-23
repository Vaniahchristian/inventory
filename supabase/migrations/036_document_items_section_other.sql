-- Add 'other' as a 4th allowed section value, for items under a section heading
-- the import pipeline's classifier doesn't recognize. Previously these were
-- silently folded into whichever section was active before the heading; now
-- they land in their own bucket instead (see kato/inventory Products page).
alter table public.document_items
  drop constraint document_items_section_check;
alter table public.document_items
  add constraint document_items_section_check
    check (section in ('shipped', 'left_in_warehouse', 'repacked', 'other'));

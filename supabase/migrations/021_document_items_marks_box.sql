-- Add marks as its own column (previously conflated into item_code),
-- and proper integer columns for box number range.
ALTER TABLE document_items
  ADD COLUMN IF NOT EXISTS marks text,
  ADD COLUMN IF NOT EXISTS box_no_start integer,
  ADD COLUMN IF NOT EXISTS box_no_end   integer;

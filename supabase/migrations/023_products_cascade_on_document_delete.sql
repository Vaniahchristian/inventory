-- Deleting a document removes compiled catalog rows that were published from it.
-- Previously: ON DELETE SET NULL left orphan products.

alter table public.products
  drop constraint if exists products_source_document_id_fkey;

alter table public.products
  add constraint products_source_document_id_fkey
    foreign key (source_document_id)
    references public.documents (id)
    on delete cascade;

alter table public.products
  drop constraint if exists products_source_document_item_id_fkey;

alter table public.products
  add constraint products_source_document_item_id_fkey
    foreign key (source_document_item_id)
    references public.document_items (id)
    on delete cascade;

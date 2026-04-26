create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

drop trigger if exists document_totals_set_updated_at on public.document_totals;
create trigger document_totals_set_updated_at
  before update on public.document_totals
  for each row execute function public.set_updated_at();

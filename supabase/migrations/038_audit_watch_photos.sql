-- Include photo / photo2 in the document_item_changes audit log.
create or replace function public.log_document_item_change()
returns trigger
language plpgsql
as $$
declare
  watched text[] := array[
    'marks', 'product_name_local', 'description', 'section',
    'total_quantity', 'total_cartons', 'total_cbm', 'total_weight_kg', 'total_amount_rmb',
    'photo', 'photo2', 'deleted_at'
  ];
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  od jsonb := '{}'::jsonb;
  nd jsonb := '{}'::jsonb;
  k text;
begin
  foreach k in array watched loop
    if (o -> k) is distinct from (n -> k) then
      od := od || jsonb_build_object(k, o -> k);
      nd := nd || jsonb_build_object(k, n -> k);
    end if;
  end loop;

  if od = '{}'::jsonb then
    return new;
  end if;

  insert into public.document_item_changes (document_item_id, document_id, action, old_values, new_values)
  values (
    new.id,
    new.document_id,
    case
      when old.deleted_at is null and new.deleted_at is not null then 'delete'
      when old.deleted_at is not null and new.deleted_at is null then 'restore'
      else 'update'
    end,
    od,
    nd
  );
  return new;
end;
$$;

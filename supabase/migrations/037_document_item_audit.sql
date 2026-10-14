-- Audit trail for document_items:
--   * original_* snapshot frozen at insert time (imported values)
--   * deleted_at soft delete (row keeps counting toward imported totals)
--   * document_item_changes log written by trigger on every update

alter table public.document_items
  add column if not exists original_total_quantity numeric,
  add column if not exists original_total_cartons numeric,
  add column if not exists original_total_cbm numeric,
  add column if not exists original_total_weight_kg numeric,
  add column if not exists original_total_amount_rmb numeric,
  add column if not exists deleted_at timestamptz;

-- Best effort: rows edited before this migration cannot be recovered.
update public.document_items set
  original_total_quantity = total_quantity,
  original_total_cartons = total_cartons,
  original_total_cbm = total_cbm,
  original_total_weight_kg = total_weight_kg,
  original_total_amount_rmb = total_amount_rmb
where original_total_quantity is null
  and original_total_cartons is null
  and original_total_cbm is null
  and original_total_weight_kg is null
  and original_total_amount_rmb is null;

create or replace function public.document_items_freeze_originals()
returns trigger
language plpgsql
as $$
begin
  new.original_total_quantity := coalesce(new.original_total_quantity, new.total_quantity);
  new.original_total_cartons := coalesce(new.original_total_cartons, new.total_cartons);
  new.original_total_cbm := coalesce(new.original_total_cbm, new.total_cbm);
  new.original_total_weight_kg := coalesce(new.original_total_weight_kg, new.total_weight_kg);
  new.original_total_amount_rmb := coalesce(new.original_total_amount_rmb, new.total_amount_rmb);
  return new;
end;
$$;

drop trigger if exists trg_document_items_freeze_originals on public.document_items;
create trigger trg_document_items_freeze_originals
before insert on public.document_items
for each row
execute function public.document_items_freeze_originals();

create table if not exists public.document_item_changes (
  id bigserial primary key,
  document_item_id uuid not null,
  document_id uuid,
  action text not null check (action in ('update', 'delete', 'restore')),
  old_values jsonb,
  new_values jsonb,
  note text,
  changed_at timestamptz not null default now()
);

create index if not exists idx_document_item_changes_doc
  on public.document_item_changes (document_id, changed_at desc);
create index if not exists idx_document_item_changes_item
  on public.document_item_changes (document_item_id, changed_at desc);

alter table public.document_item_changes enable row level security;
drop policy if exists "Allow all document_item_changes" on public.document_item_changes;
create policy "Allow all document_item_changes" on public.document_item_changes
  for all using (true) with check (true);

create or replace function public.log_document_item_change()
returns trigger
language plpgsql
as $$
declare
  watched text[] := array[
    'marks', 'product_name_local', 'description', 'section',
    'total_quantity', 'total_cartons', 'total_cbm', 'total_weight_kg', 'total_amount_rmb',
    'deleted_at'
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

drop trigger if exists trg_document_items_log_change on public.document_items;
create trigger trg_document_items_log_change
after update on public.document_items
for each row
execute function public.log_document_item_change();

-- Live totals ignore soft-deleted rows.
create or replace function public.sync_document_totals_from_items()
returns trigger
language plpgsql
as $$
declare
  v_doc_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_doc_id := OLD.document_id;
  else
    v_doc_id := NEW.document_id;
  end if;
  if v_doc_id is null then
    return coalesce(NEW, OLD);
  end if;

  update public.document_totals dt
  set
    computed_cartons = agg.sum_cartons,
    computed_quantity = agg.sum_qty,
    computed_amount_rmb = agg.sum_amount_rmb,
    computed_cbm = agg.sum_cbm,
    computed_weight_kg = agg.sum_weight_kg,
    totals_match =
      (coalesce(dt.total_cartons, agg.sum_cartons) = agg.sum_cartons) and
      (coalesce(dt.total_amount_rmb, agg.sum_amount_rmb) = agg.sum_amount_rmb) and
      (coalesce(dt.total_cbm, agg.sum_cbm) = agg.sum_cbm) and
      (coalesce(dt.total_weight_kg, agg.sum_weight_kg) = agg.sum_weight_kg),
    totals_diff = jsonb_build_object(
      'cartons', agg.sum_cartons - coalesce(dt.total_cartons, agg.sum_cartons),
      'quantity', agg.sum_qty - coalesce(dt.total_quantity, agg.sum_qty),
      'amount_rmb', agg.sum_amount_rmb - coalesce(dt.total_amount_rmb, agg.sum_amount_rmb),
      'cbm', agg.sum_cbm - coalesce(dt.total_cbm, agg.sum_cbm),
      'weight_kg', agg.sum_weight_kg - coalesce(dt.total_weight_kg, agg.sum_weight_kg)
    ),
    updated_at = now()
  from (
    select
      v_doc_id as document_id,
      coalesce(sum(di.total_cartons), 0)::numeric as sum_cartons,
      coalesce(sum(di.total_quantity), 0)::numeric as sum_qty,
      coalesce(sum(di.total_amount_rmb), 0)::numeric as sum_amount_rmb,
      coalesce(sum(di.total_cbm), 0)::numeric as sum_cbm,
      coalesce(sum(di.total_weight_kg), 0)::numeric as sum_weight_kg
    from public.document_items di
    where di.document_id = v_doc_id
      and di.deleted_at is null
      and coalesce(di.item_code, '') not in ('__FOOTER__', '__SECTION_SUBTOTAL__', '__FULL_EXTRACT__')
  ) agg
  where dt.document_id = agg.document_id;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

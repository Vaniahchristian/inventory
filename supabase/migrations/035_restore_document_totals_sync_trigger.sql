-- Re-enable automatic recomputation of document_totals when line items change.
-- (Row-level sales_order normalizer stays removed — see 034.)

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
      di.document_id,
      coalesce(sum(di.total_cartons), 0)::numeric as sum_cartons,
      coalesce(sum(di.total_quantity), 0)::numeric as sum_qty,
      coalesce(sum(di.total_amount_rmb), 0)::numeric as sum_amount_rmb,
      coalesce(sum(di.total_cbm), 0)::numeric as sum_cbm,
      coalesce(sum(di.total_weight_kg), 0)::numeric as sum_weight_kg
    from public.document_items di
    where di.document_id = v_doc_id
      and coalesce(di.item_code, '') not in ('__FOOTER__', '__SECTION_SUBTOTAL__', '__FULL_EXTRACT__')
    group by di.document_id
  ) agg
  where dt.document_id = agg.document_id;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_document_items_sync_totals on public.document_items;
create trigger trg_document_items_sync_totals
after insert or update or delete on public.document_items
for each row
execute function public.sync_document_totals_from_items();

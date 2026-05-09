-- One-time backfill:
-- Re-run row normalizer for likely-misaligned sales_order items already saved in DB,
-- then refresh document totals/status for affected documents.

DO $$
DECLARE
  v_touched_rows integer := 0;
BEGIN
  create temporary table _affected_docs (
    document_id uuid primary key
  ) on commit drop;

  insert into _affected_docs(document_id)
  select distinct di.document_id
  from public.document_items di
  join public.documents d on d.id = di.document_id
  where d.document_type = 'sales_order'
    and (
      (
        coalesce(di.description, '') ~* '(浦江仓|浙江仓|东阳仓|[0-9]+仓|刀叉勺)'
        and (
          di.total_cartons is null
          or di.qty_per_carton is null
          or di.total_quantity is null
          or di.total_amount_rmb is null
          or di.dim_l_cm is null
          or di.dim_w_cm is null
          or di.dim_h_cm is null
          or di.total_cbm is null
          or di.total_weight_kg is null
          or di.warehouse is null
        )
      )
      or (
        (di.marks is null or btrim(di.marks) = '')
        and (
          coalesce(di.item_code, '') ~* '^SAN[0-9A-Z-]+$'
          or coalesce(di.description, '') ~* '^\s*SAN[0-9A-Z-]+\b'
        )
      )
      or coalesce(di.warehouse, '') ~* '\s+(PCS|SET|DCS|PS|PCS/SE)\s*$'
    );

  -- Touch rows to invoke BEFORE UPDATE normalizer trigger.
  update public.document_items di
  set remarks = di.remarks
  where di.document_id in (select document_id from _affected_docs);

  GET DIAGNOSTICS v_touched_rows = ROW_COUNT;

  -- Ensure computed totals/status are synchronized after backfill,
  -- including documents where all items might have been deleted/edited.
  update public.document_totals dt
  set
    computed_cartons = coalesce(agg.sum_cartons, 0),
    computed_quantity = coalesce(agg.sum_qty, 0),
    computed_amount_rmb = coalesce(agg.sum_amount_rmb, 0),
    computed_cbm = coalesce(agg.sum_cbm, 0),
    computed_weight_kg = coalesce(agg.sum_weight_kg, 0),
    totals_match =
      (coalesce(dt.total_cartons, coalesce(agg.sum_cartons, 0)) = coalesce(agg.sum_cartons, 0)) and
      (coalesce(dt.total_amount_rmb, coalesce(agg.sum_amount_rmb, 0)) = coalesce(agg.sum_amount_rmb, 0)) and
      (coalesce(dt.total_cbm, coalesce(agg.sum_cbm, 0)) = coalesce(agg.sum_cbm, 0)) and
      (coalesce(dt.total_weight_kg, coalesce(agg.sum_weight_kg, 0)) = coalesce(agg.sum_weight_kg, 0)),
    totals_diff = jsonb_build_object(
      'cartons', coalesce(agg.sum_cartons, 0) - coalesce(dt.total_cartons, coalesce(agg.sum_cartons, 0)),
      'quantity', coalesce(agg.sum_qty, 0) - coalesce(dt.total_quantity, coalesce(agg.sum_qty, 0)),
      'amount_rmb', coalesce(agg.sum_amount_rmb, 0) - coalesce(dt.total_amount_rmb, coalesce(agg.sum_amount_rmb, 0)),
      'cbm', coalesce(agg.sum_cbm, 0) - coalesce(dt.total_cbm, coalesce(agg.sum_cbm, 0)),
      'weight_kg', coalesce(agg.sum_weight_kg, 0) - coalesce(dt.total_weight_kg, coalesce(agg.sum_weight_kg, 0))
    ),
    updated_at = now()
  from (
    select
      ad.document_id,
      sum(coalesce(di.total_cartons, 0))::numeric as sum_cartons,
      sum(coalesce(di.total_quantity, 0))::numeric as sum_qty,
      sum(coalesce(di.total_amount_rmb, 0))::numeric as sum_amount_rmb,
      sum(coalesce(di.total_cbm, 0))::numeric as sum_cbm,
      sum(coalesce(di.total_weight_kg, 0))::numeric as sum_weight_kg
    from _affected_docs ad
    left join public.document_items di on di.document_id = ad.document_id
    group by ad.document_id
  ) agg
  where dt.document_id = agg.document_id;

  update public.documents d
  set
    extraction_status = case
      when dt.totals_match then 'approved'
      else 'review_needed'
    end,
    updated_at = now()
  from public.document_totals dt
  where d.id = dt.document_id
    and d.id in (select document_id from _affected_docs);

  RAISE NOTICE 'backfill_sales_order_alignment: touched % rows', v_touched_rows;
END $$;


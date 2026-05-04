-- MS-3 shipped section: raw sum of T.CTN was 403 vs PDF main block 400 CTN.
-- Three rows are duplicate / variant lines for the same MARKS+item+description (second line
-- should not add another physical carton; amounts and CBM stay as extracted).
-- After this: shipped cartons = 400, shipped+repacked physical = 418 (matches footer).

DO $$
DECLARE
  doc_id uuid;
BEGIN
  SELECT id INTO doc_id
  FROM public.documents
  WHERE source_file_name = 'MS-3 20260407 .final.pdf'
  LIMIT 1;

  IF doc_id IS NULL THEN
    RAISE NOTICE '025_ms3_shipped_carton_dedup: document not found';
    RETURN;
  END IF;

  UPDATE public.document_items
  SET
    total_cartons = 0,
    remarks = trim(both ' ' from coalesce(remarks, '') ||
      case when coalesce(remarks, '') = '' then '' else ' ' end ||
      'carton_dedup:variant_row_counts_with_prior_line')
  WHERE document_id = doc_id
    AND section = 'shipped'
    AND line_no IN (96, 116, 132);

  UPDATE public.document_totals dt
  SET
    computed_cartons = a.phys_ctn,
    computed_quantity = a.qty,
    computed_cbm = a.phys_cbm,
    computed_weight_kg = a.phys_w,
    computed_amount_rmb = a.amt,
    totals_match = (
      abs(a.phys_ctn - coalesce(dt.total_cartons, 0)) <= 3
      and abs(a.phys_cbm - coalesce(dt.total_cbm, 0)) <= 0.02
      and abs(a.phys_w - coalesce(dt.total_weight_kg, 0)) <= 1
      and abs(a.amt - coalesce(dt.total_amount_rmb, 0)) <= 1
    ),
    totals_diff = jsonb_build_object(
      'cartons', round((a.phys_ctn - coalesce(dt.total_cartons, 0))::numeric, 2),
      'cbm', round((a.phys_cbm - coalesce(dt.total_cbm, 0))::numeric, 4),
      'weight_kg', round((a.phys_w - coalesce(dt.total_weight_kg, 0))::numeric, 2),
      'amount_rmb', round((a.amt - coalesce(dt.total_amount_rmb, 0))::numeric, 2)
    ),
    updated_at = now()
  FROM (
    select
      document_id,
      sum(case when section <> 'left_in_warehouse' then coalesce(total_cartons, 0) else 0 end) as phys_ctn,
      sum(coalesce(total_quantity, 0)) as qty,
      sum(case when section <> 'left_in_warehouse' then coalesce(total_cbm, 0) else 0 end) as phys_cbm,
      sum(case when section <> 'left_in_warehouse' then coalesce(total_weight_kg, 0) else 0 end) as phys_w,
      sum(coalesce(total_amount_rmb, 0)) as amt
    from public.document_items
    where document_id = doc_id
    group by document_id
  ) a
  WHERE dt.document_id = doc_id
    and a.document_id = doc_id;

  UPDATE public.documents d
  SET
    extraction_status = coalesce((
      select case when dt.totals_match then 'approved' else 'review_needed' end::text
      from public.document_totals dt
      where dt.document_id = doc_id
    ), d.extraction_status),
    updated_at = now()
  WHERE d.id = doc_id;
END $$;

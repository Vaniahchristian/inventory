-- One-time alignment for MS-3 20260407 .final.pdf:
-- 1) Move misclassified repacked rows (oven + grinder) to left_in_warehouse
-- 2) Seed GOODS LEFT IN SANCARGO line items (PDF p.8–9 subtotal 63 CTN / ¥30,995)
-- 3) Repair orphaned shipped row (line 96)
-- 4) Recompute document_totals.computed_* and totals_match

DO $$
DECLARE
  doc_id uuid;
BEGIN
  SELECT id INTO doc_id
  FROM public.documents
  WHERE source_file_name = 'MS-3 20260407 .final.pdf'
  LIMIT 1;

  IF doc_id IS NULL THEN
    RAISE NOTICE 'align_ms3: document not found, skip';
    RETURN;
  END IF;

  UPDATE public.document_items
  SET section = 'left_in_warehouse'
  WHERE document_id = doc_id
    AND line_no IN (163, 164);

  UPDATE public.document_items
  SET
    description = 'Sleepwear 25612*',
    item_code = coalesce(nullif(trim(item_code), ''), '1'),
    shop = coalesce(nullif(trim(shop), ''), '柔妃49348')
  WHERE document_id = doc_id
    AND line_no = 96
    AND description IS NULL;

  DELETE FROM public.document_items
  WHERE document_id = doc_id
    AND line_no BETWEEN 165 AND 183;

  INSERT INTO public.document_items (
    document_id, line_no, marks, item_code, description, shop, packaging,
    total_cartons, total_quantity, unit_price_rmb, total_amount_rmb,
    dim_l_cm, dim_w_cm, dim_h_cm, unit_cbm, total_cbm, unit_weight_kg, total_weight_kg,
    section, validation_flags, extraction_confidence, remarks
  ) VALUES
  (doc_id, 165, 'MS-301-24 SANCARGO', '24', 'Cake Showcase accessories|底座', '新南方', NULL,
    3, NULL, NULL, NULL, 77, 78, 54, 0.324, 0.973, 24, 72,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 166, 'MS-301-24 SANCARGO', '24', 'Cake Showcase accessories|盖板', '新南方', NULL,
    12, NULL, NULL, NULL, 54, 73, 53, 0.209, 2.507, 34, 408,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 167, 'MS-301-24 SANCARGO', '24', 'Cake Showcase accessories|纸箱', '新南方', NULL,
    4, NULL, NULL, NULL, 80, 60, 120, 0.576, 2.304, 15, 60,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 168, 'MS-301-12 SANCARGO', '12', 'Electric griddle 818 grill', '新南方', '1pcs/ctn',
    11, 11, 240, 2640, 20, 47, 60, 0.056, 0.620, 19.5, 214.5,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 169, 'MS-301-13 SANCARGO', '13', 'Electric griddle 820 grill', '新南方', '1pcs/ctn',
    5, 5, 420, 2100, 20, 53, 78, 0.083, 0.413, 25.1, 125.5,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 170, 'MS-301-20 SANCARGO', '20', 'Meat Dryer 10 layer dryer', '新南方', '1pcs/ctn',
    1, 1, 650, 650, 48, 47, 53, 0.120, 0.120, 13, 13,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 171, 'MS-303-4/5 SANCARGO', '4,5', 'Electric food warmer 配套的 1/1 10cm带 cover', '俊达', '10pcs/ctn',
    1, 20, 0, 0, 42, 36, 56, 0.085, 0.085, 22.5, 22.5,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 172, 'MS-303-15 SANCARGO', '15', 'Ice maker ice maker 40kg', '俊达', '1pcs/ctn',
    1, 1, 1950, 1950, 68, 46, 50, 0.156, 0.156, 22.5, 22.5,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 173, 'MS-303-16 SANCARGO', '16', 'Ice maker ice maker 50kg', '俊达', '1pcs/ctn',
    1, 1, 2150, 2150, 75, 62, 46, 0.214, 0.214, 34, 34,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 174, 'MS-303-7 SANCARGO', '7', 'Salad Bar Display Counter 沙拉台', '俊达', '1pcs/ctn',
    2, 2, 2250, 4500, 35, 46, 167, 0.269, 0.538, 47, 94,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 175, 'MS-305-2 SANCARGO', '2', 'Plastic chairs YH-8035绿5米白5', '远航户外', '4pcs/ctn',
    2, 8, 105, 840, 53, 58, 68, 0.209, 0.418, 18, 36,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 176, 'MS-302-18 SANCARGO', '18', 'Panini maker 813 双头压板扒炉', '东田', '1pcs/ctn',
    2, 2, 650, 1300, 28, 45, 65, 0.082, 0.164, 26, 52,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 177, 'MS-302-19 SANCARGO', '19', 'Hand Press Juicer 手压榨汁机1158B款黑色', '东田', '3pcs/ctn',
    3, 9, 95, 855, 45, 30, 60, 0.081, 0.243, 20, 60,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 178, 'MS-302-15 SANCARGO', '15', 'Ice Cream Cone Maker|双头雪糕皮机', '东田', '1pcs/ctn',
    2, 2, 550, 1100, 31, 41, 55, 0.070, 0.140, 11, 22,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 179, 'MS-302-28 SANCARGO', '28', 'Electric Toaster ETS-4片多士炉', '东田', '4pcs/ctn',
    1, 4, 280, 1120, 53, 31, 67, 0.110, 0.110, 18.5, 18.5,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 180, 'MS-302-3 SANCARGO', '3', 'Food Mixer|B30B搅拌机', '东田', '1pcs/ctn',
    1, 1, 2000, 2000, 99, 51, 61, 0.308, 0.308, 76, 76,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 181, 'MS-302-23 SANCARGO', '23', 'Meat grinder TK-22半钢绞肉机', '东田', '1pcs/ctn',
    2, 2, 850, 1700, 53, 38, 51, 0.103, 0.205, 27, 54,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 182, 'MS-302-27 SANCARGO', '27', 'Electric Plate Warming cart 双头暖碟车', '东田', '1pcs/ctn',
    1, 1, 2100, 2100, 100, 53, 101, 0.535, 0.535, 60, 60,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo'),
  (doc_id, 183, 'MS-302-22 SANCARGO', '22', 'Meat grinder TK-12半钢绞肉机', '东田', '1pcs/ctn',
    2, 2, 550, 1100, 45, 33, 45, 0.067, 0.134, 20, 40,
    'left_in_warehouse', '[]'::jsonb, 85, 'pdf:goods_left_sancargo');

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

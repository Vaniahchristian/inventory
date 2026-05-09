-- Keep sales-order rows aligned during Live View saves/imports and
-- keep document_totals synchronized after item changes.

create or replace function public.normalize_document_item_sales_outliers()
returns trigger
language plpgsql
as $$
declare
  v_doc_type text;
  v_wh text;
  v_desc text;
  v_before_wh text;
  v_nums text[];
  v_n int;
  v_ctn numeric;
  v_qty_per numeric;
  v_tqty numeric;
  v_uprice numeric;
  v_amt numeric;
  v_l numeric;
  v_w numeric;
  v_h numeric;
  v_ucbm numeric;
  v_uw numeric;
  v_tcbm numeric;
  v_tkgs numeric;
begin
  select d.document_type into v_doc_type
  from public.documents d
  where d.id = NEW.document_id;

  if coalesce(v_doc_type, '') <> 'sales_order' then
    return NEW;
  end if;

  -- Recover shifted SANxx marks.
  if (NEW.marks is null or btrim(NEW.marks) = '')
     and NEW.item_code is not null
     and NEW.item_code ~* '^SAN[0-9A-Z-]+$' then
    NEW.marks := upper(NEW.item_code);
  end if;

  -- Normalize merged warehouse/unit cells (e.g. "浙江仓 PCS" -> "浙江仓").
  if NEW.warehouse is not null and btrim(NEW.warehouse) <> '' then
    NEW.warehouse := regexp_replace(NEW.warehouse, '\s+', ' ', 'g');
    NEW.warehouse := regexp_replace(NEW.warehouse, '\s+(PCS|SET|DCS|PS|PCS/SE)\s*$', '', 'i');
  end if;

  -- Recover collapsed numeric tails from description only when row is clearly misaligned.
  v_desc := coalesce(NEW.description, '');
  if v_desc <> '' and (
       NEW.total_cartons is null
    or NEW.qty_per_carton is null
    or NEW.total_quantity is null
    or NEW.total_amount_rmb is null
    or NEW.dim_l_cm is null
    or NEW.dim_w_cm is null
    or NEW.dim_h_cm is null
    or NEW.total_cbm is null
    or NEW.total_weight_kg is null
    or NEW.warehouse is null
  ) then
    v_wh := null;
    select m[1] into v_wh
    from regexp_match(v_desc, '(浦江仓|浙江仓|东阳仓|[0-9]+仓|刀叉勺)', 'i') as m;

    if v_wh is not null then
      v_before_wh := regexp_replace(v_desc, '(浦江仓|浙江仓|东阳仓|[0-9]+仓|刀叉勺).*$', '', 'i');
      v_nums := regexp_split_to_array(
        trim(regexp_replace(v_before_wh, '[^0-9.]+', ' ', 'g')),
        '\s+'
      );
      v_n := coalesce(array_length(v_nums, 1), 0);

      if v_n >= 12 then
        -- Right-anchored 12-number tail:
        -- CTN, QTY, T.QTY, U/P, AMOUNT, L, W, H, U.CBM, U.W, T.CBM, T.KGS
        v_ctn    := nullif(v_nums[v_n - 11], '')::numeric;
        v_qty_per:= nullif(v_nums[v_n - 10], '')::numeric;
        v_tqty   := nullif(v_nums[v_n - 9], '')::numeric;
        v_uprice := nullif(v_nums[v_n - 8], '')::numeric;
        v_amt    := nullif(v_nums[v_n - 7], '')::numeric;
        v_l      := nullif(v_nums[v_n - 6], '')::numeric;
        v_w      := nullif(v_nums[v_n - 5], '')::numeric;
        v_h      := nullif(v_nums[v_n - 4], '')::numeric;
        v_ucbm   := nullif(v_nums[v_n - 3], '')::numeric;
        v_uw     := nullif(v_nums[v_n - 2], '')::numeric;
        v_tcbm   := nullif(v_nums[v_n - 1], '')::numeric;
        v_tkgs   := nullif(v_nums[v_n], '')::numeric;

        if v_tqty > 0 and v_uprice > 0 and v_amt > 0
           and abs((v_tqty * v_uprice) - v_amt) <= greatest(2, v_amt * 0.06)
           and v_l > 0 and v_w > 0 and v_h > 0
           and v_l < 300 and v_w < 300 and v_h < 300
           and v_ucbm > 0 and v_ucbm < 5
           and v_tcbm > 0 and v_tcbm < 30
           and v_tkgs > 0 and v_tkgs < 5000 then
          if NEW.qty_per_carton is null and v_qty_per > 0 then NEW.qty_per_carton := v_qty_per; end if;
          if NEW.total_cartons is null and v_ctn > 0 then NEW.total_cartons := v_ctn; end if;
          if NEW.total_quantity is null then NEW.total_quantity := v_tqty; end if;
          if NEW.unit_price_rmb is null then NEW.unit_price_rmb := v_uprice; end if;
          if NEW.total_amount_rmb is null then NEW.total_amount_rmb := v_amt; end if;
          if NEW.dim_l_cm is null then NEW.dim_l_cm := v_l; end if;
          if NEW.dim_w_cm is null then NEW.dim_w_cm := v_w; end if;
          if NEW.dim_h_cm is null then NEW.dim_h_cm := v_h; end if;
          if NEW.unit_cbm is null then NEW.unit_cbm := v_ucbm; end if;
          if NEW.unit_weight_kg is null then NEW.unit_weight_kg := v_uw; end if;
          if NEW.total_cbm is null then NEW.total_cbm := v_tcbm; end if;
          if NEW.total_weight_kg is null then NEW.total_weight_kg := v_tkgs; end if;
          if NEW.warehouse is null then NEW.warehouse := v_wh; end if;
        end if;
      end if;
    end if;
  end if;

  -- Final carton sanity fix: if cartons clearly inflated, derive from qty ratio.
  if NEW.qty_per_carton is not null and NEW.qty_per_carton > 0 and NEW.total_quantity is not null then
    if NEW.total_cartons is null then
      NEW.total_cartons := round((NEW.total_quantity / NEW.qty_per_carton)::numeric, 3);
    elsif NEW.total_cartons > NEW.total_quantity then
      NEW.total_cartons := round((NEW.total_quantity / NEW.qty_per_carton)::numeric, 3);
    end if;
  end if;

  return NEW;
end;
$$;

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
    group by di.document_id
  ) agg
  where dt.document_id = agg.document_id;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_document_items_normalize_sales_outliers on public.document_items;
create trigger trg_document_items_normalize_sales_outliers
before insert or update on public.document_items
for each row
execute function public.normalize_document_item_sales_outliers();

drop trigger if exists trg_document_items_sync_totals on public.document_items;
create trigger trg_document_items_sync_totals
after insert or update or delete on public.document_items
for each row
execute function public.sync_document_totals_from_items();


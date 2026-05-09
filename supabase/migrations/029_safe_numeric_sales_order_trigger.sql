-- Trigger previously did nullif(token,'')::numeric; lone '.' is not null and casts fail,
-- aborting INSERT with: invalid input syntax for type numeric: "."

create or replace function public.safe_numeric_from_text(t text)
returns numeric
language plpgsql
immutable
as $$
begin
  if t is null then
    return null;
  end if;
  t := btrim(t);
  if t = '' or t in ('.', '-', '+', '-.', '+.') then
    return null;
  end if;
  return t::numeric;
exception
  when invalid_text_representation then
    return null;
end;
$$;

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

  if (NEW.marks is null or btrim(NEW.marks) = '')
     and NEW.item_code is not null
     and (
       NEW.item_code ~* '^SAN[0-9A-Z-]+$'
       or NEW.item_code ~* '^[0-9]{2}[A-Z][0-9]{3}-[0-9A-Z]+$'
       or NEW.item_code ~* '^[A-Z][0-9]{2}-[0-9]{4,}$'
     ) then
    NEW.marks := upper(NEW.item_code);
  end if;

  if NEW.warehouse is not null and btrim(NEW.warehouse) <> '' then
    NEW.warehouse := regexp_replace(NEW.warehouse, '\s+', ' ', 'g');
    NEW.warehouse := regexp_replace(NEW.warehouse, '\s+(PCS|SET|DCS|PS|PCS/SE)\s*$', '', 'i');
  end if;

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
        v_ctn    := safe_numeric_from_text(v_nums[v_n - 11]);
        v_qty_per:= safe_numeric_from_text(v_nums[v_n - 10]);
        v_tqty   := safe_numeric_from_text(v_nums[v_n - 9]);
        v_uprice := safe_numeric_from_text(v_nums[v_n - 8]);
        v_amt    := safe_numeric_from_text(v_nums[v_n - 7]);
        v_l      := safe_numeric_from_text(v_nums[v_n - 6]);
        v_w      := safe_numeric_from_text(v_nums[v_n - 5]);
        v_h      := safe_numeric_from_text(v_nums[v_n - 4]);
        v_ucbm   := safe_numeric_from_text(v_nums[v_n - 3]);
        v_uw     := safe_numeric_from_text(v_nums[v_n - 2]);
        v_tcbm   := safe_numeric_from_text(v_nums[v_n - 1]);
        v_tkgs   := safe_numeric_from_text(v_nums[v_n]);

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

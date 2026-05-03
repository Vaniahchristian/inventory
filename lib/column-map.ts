/**
 * Fix 2: Single source of truth for PDF column header → field name mapping.
 * Used by the deterministic HTML table parser and referenced in system prompts.
 * All lookups normalise through normaliseHeader() before matching.
 */

import type { DocType } from './prompts'

export type ProductField =
  | 'line_no' | 'marks' | 'shop' | 'item_code' | 'description' | 'packaging'
  | 'qty_per_carton' | 'total_cartons' | 'total_qty'
  | 'dim_l_cm' | 'dim_w_cm' | 'dim_h_cm'
  | 'unit_cbm' | 'total_cbm' | 'unit_weight_kg' | 'total_weight_kg'
  | 'unit_price_rmb' | 'total_amount_rmb'
  | 'barcode' | 'warehouse' | 'box_no_start' | 'box_no_end' | 'remarks'

/** Container manifest / packing list column headers → fields */
export const CONTAINER_COLUMNS: Record<string, ProductField | 'skip'> = {
  // Line number
  'NO': 'line_no', 'NO.': 'line_no', '序号': 'line_no',
  // Product code / marks
  'MARKS': 'marks', '唛头': 'marks',
  // Shop / supplier
  'SHOP': 'shop', 'SHOP#': 'shop', 'SUPPLIER': 'shop', 'SHOP/IMAGE': 'shop',
  // Item number
  'ITEM NO': 'item_code', 'ITEM NO.': 'item_code', 'ITEM': 'item_code',
  // Description
  'DESCRIPTION': 'description', 'DESCRIPTION OF GOODS': 'description', '品名': 'description',
  // Packing string (e.g. "120pcs/ctn") — qty_per_carton derived from this
  'PACKING': 'packaging', 'QTY/CTN': 'packaging', 'PCS/CTN': 'packaging', 'QTY/CARTON': 'packaging',
  // Carton count
  'T.CTN': 'total_cartons', 'CTNS': 'total_cartons', 'T CTN': 'total_cartons',
  'TOTAL CTNS': 'total_cartons', 'TOTAL CARTONS': 'total_cartons',
  // Piece count
  'T.QTY': 'total_qty', 'TOTAL QTY': 'total_qty', 'T QTY': 'total_qty', 'TOTAL QUANTITY': 'total_qty',
  // Dimensions
  'L': 'dim_l_cm', 'L(CM)': 'dim_l_cm', 'LENGTH': 'dim_l_cm',
  'W': 'dim_w_cm', 'W(CM)': 'dim_w_cm', 'WIDTH': 'dim_w_cm',
  'H': 'dim_h_cm', 'H(CM)': 'dim_h_cm', 'HEIGHT': 'dim_h_cm',
  // Volume
  'UNIT CBM': 'unit_cbm', 'U.CBM': 'unit_cbm',
  'T.CBM': 'total_cbm', 'TOTAL CBM': 'total_cbm', 'T CBM': 'total_cbm',
  // Weight
  'UNIT WEIGHT': 'unit_weight_kg', 'UNIT WEIGHT(KG)': 'unit_weight_kg', 'U.WEIGHT': 'unit_weight_kg', 'U.W': 'unit_weight_kg',
  'T.WEIGHT': 'total_weight_kg', 'TOTAL WEIGHT': 'total_weight_kg', 'TOTAL WEIGHT(KG)': 'total_weight_kg', 'T.W': 'total_weight_kg', 'T WEIGHT': 'total_weight_kg',
  // Price — actual PDF header is "U.PRICE (RMB)"; OCR/HTML often emits U.PRICE(RMB) without space
  'U/P': 'unit_price_rmb', 'UNIT PRICE': 'unit_price_rmb', 'U.PRICE': 'unit_price_rmb',
  'U.PRICE (RMB)': 'unit_price_rmb', 'U.PRICE(RMB)': 'unit_price_rmb', 'UNIT PRICE(RMB)': 'unit_price_rmb',
  'UNIT PRICE(¥)': 'unit_price_rmb', 'UNIT PRICE (RMB)': 'unit_price_rmb', 'UNIT PRICE (¥)': 'unit_price_rmb',
  'PRICE (RMB)': 'unit_price_rmb', 'U PRICE (RMB)': 'unit_price_rmb',
  'T.AMOUNT': 'total_amount_rmb', 'TOTAL AMOUNT': 'total_amount_rmb',
  'T.AMOUNT(¥)': 'total_amount_rmb', 'T.AMOUNT(RMB)': 'total_amount_rmb',
  'TOTAL AMOUNT(¥)': 'total_amount_rmb', 'AMOUNT': 'total_amount_rmb',
  // Box range — actual PDF header is "BOX .NO"
  'BOX NO': 'box_no_start', 'BOX NO.': 'box_no_start', 'BOX .NO': 'box_no_start', 'BOX': 'box_no_start',
  // Other
  'BARCODE': 'barcode', 'WAREHOUSE': 'warehouse', 'REMARKS': 'remarks',
  'IMAGE': 'skip',
}

/** Sales order column headers → fields */
export const SALES_ORDER_COLUMNS: Record<string, ProductField | 'skip'> = {
  '序号': 'line_no', 'NO': 'line_no', 'NO.': 'line_no',
  '产品货号': 'item_code', 'ITEM CODE': 'item_code', 'SKU': 'item_code',
  '客户货号': 'skip',
  '描述': 'description', 'DESCRIPTION': 'description',
  '总箱数': 'total_cartons', 'TOTAL CARTONS': 'total_cartons', 'CTNS': 'total_cartons',
  '每箱数量': 'packaging', 'QTY/CTN': 'packaging',
  '总数量': 'total_qty', 'TOTAL QTY': 'total_qty',
  '单价': 'unit_price_rmb', 'UNIT PRICE': 'unit_price_rmb',
  '金额': 'total_amount_rmb', 'AMOUNT': 'total_amount_rmb',
  '长': 'dim_l_cm', 'L': 'dim_l_cm', 'L(CM)': 'dim_l_cm',
  '宽': 'dim_w_cm', 'W': 'dim_w_cm', 'W(CM)': 'dim_w_cm',
  '高': 'dim_h_cm', 'H': 'dim_h_cm', 'H(CM)': 'dim_h_cm',
  '体积': 'unit_cbm', 'UNIT CBM': 'unit_cbm',
  '总体积': 'total_cbm', 'TOTAL CBM': 'total_cbm',
  '重量': 'unit_weight_kg', 'UNIT WEIGHT': 'unit_weight_kg', 'UNIT WEIGHT(KG)': 'unit_weight_kg',
  '总重量': 'total_weight_kg', 'TOTAL WEIGHT': 'total_weight_kg', 'TOTAL WEIGHT(KG)': 'total_weight_kg',
  '条形码': 'barcode', 'BARCODE': 'barcode',
  '仓位': 'warehouse', 'WAREHOUSE': 'warehouse',
  '备注': 'remarks', 'REMARKS': 'remarks',
}

export function normaliseHeader(raw: string): string {
  let s = raw
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .trim()
  // Glue variants from PDFs/HTML: "U.PRICE(RMB)" → canonical "U.PRICE (RMB)"
  s = s
    .replace(/\bU\.PRICE\s*\(/g, 'U.PRICE (')
    .replace(/\bUNIT\s+PRICE\s*\(/g, 'UNIT PRICE (')
    .replace(/\bT\.AMOUNT\s*\(/g, 'T.AMOUNT (')
  return s.replace(/\s+/g, ' ').trim()
}

export function resolveColumn(
  header: string,
  docType: DocType
): ProductField | 'skip' | null {
  const key = normaliseHeader(header)
  const map = docType === 'sales_order' ? SALES_ORDER_COLUMNS : CONTAINER_COLUMNS
  return map[key] ?? null
}

/** Human-readable column order — used verbatim in system prompts */
export const CONTAINER_COLUMN_ORDER =
  'MARKS | SHOP/IMAGE | ITEM NO | DESCRIPTION | PACKING(qty/ctn) | T.CTN | TOTAL QTY | L(cm) | W(cm) | H(cm) | UNIT CBM | TOTAL CBM | UNIT WEIGHT(KG) | TOTAL WEIGHT(KG) | UNIT PRICE(¥) | TOTAL AMOUNT(¥)'

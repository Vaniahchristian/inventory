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
  'NO. 序号': 'line_no',
  'DATE': 'skip', '订单日期': 'skip', 'DATE 订单日期': 'skip',
  'ORD NO': 'marks', 'ORD NO.': 'marks', '销售单号': 'marks', 'ORD NO. 销售单号': 'marks',
  'DEL NO': 'marks', 'DEL NO.': 'marks', '送货单号': 'marks', 'DEL NO. 送货单号': 'marks',
  'CUS NO': 'skip', 'CUS NO.': 'skip', '客户货号': 'skip', 'CUS NO. 客户货号': 'skip',
  'ITEM NO': 'item_code', 'ITEM NO.': 'item_code', 'ITEM NO. 产品货号': 'item_code',
  '产品货号': 'item_code', 'ITEM CODE': 'item_code', 'SKU': 'item_code',
  'DES': 'description', 'DES.': 'description', 'DESCRIPTION': 'description', 'DES. 描述': 'description', '描述': 'description',
  'PHOTO': 'skip', 'PHOTO2': 'skip', '图片1': 'skip',
  'CTN': 'total_cartons', '总箱数': 'total_cartons', 'TOTAL CARTONS': 'total_cartons', 'CTNS': 'total_cartons',
  'CTN 总箱数': 'total_cartons',
  'QTY': 'packaging',
  '每箱数量': 'packaging', 'QTY/CTN': 'packaging',
  'QTY 每箱数量': 'packaging',
  'T.QTY': 'total_qty', '总数量': 'total_qty', 'TOTAL QTY': 'total_qty',
  'T.QTY 总数量': 'total_qty',
  'U/P': 'unit_price_rmb', '单价': 'unit_price_rmb', 'UNIT PRICE': 'unit_price_rmb',
  'U/P 单价': 'unit_price_rmb',
  '金额': 'total_amount_rmb', 'AMOUNT': 'total_amount_rmb', 'AMOUNT 金额': 'total_amount_rmb',
  '长': 'dim_l_cm', 'L': 'dim_l_cm', 'L(CM)': 'dim_l_cm',
  'L 长': 'dim_l_cm',
  '宽': 'dim_w_cm', 'W': 'dim_w_cm', 'W(CM)': 'dim_w_cm',
  'W 宽': 'dim_w_cm',
  '高': 'dim_h_cm', 'H': 'dim_h_cm', 'H(CM)': 'dim_h_cm',
  'H 高': 'dim_h_cm',
  'CBM': 'unit_cbm', '体积': 'unit_cbm', 'UNIT CBM': 'unit_cbm', 'CBM 体积': 'unit_cbm',
  'T.T.CBM': 'total_cbm', '总体积': 'total_cbm', 'TOTAL CBM': 'total_cbm', 'T.T.CBM 总体积': 'total_cbm',
  'G.W': 'unit_weight_kg', '重量': 'unit_weight_kg', 'UNIT WEIGHT': 'unit_weight_kg', 'UNIT WEIGHT(KG)': 'unit_weight_kg', 'G.W. 重量': 'unit_weight_kg',
  'T.T.KGS': 'total_weight_kg', '总重量': 'total_weight_kg', 'TOTAL WEIGHT': 'total_weight_kg', 'TOTAL WEIGHT(KG)': 'total_weight_kg', 'T.T.KGS 总重量': 'total_weight_kg',
  'CODE': 'barcode',
  '条形码': 'barcode', 'BARCODE': 'barcode',
  'CODE 条形码': 'barcode',
  'W.H': 'warehouse',
  '仓位': 'warehouse', 'WAREHOUSE': 'warehouse',
  'W.H. 仓位': 'warehouse',
  'REK': 'remarks',
  '备注': 'remarks', 'REMARKS': 'remarks',
  'REK 备注': 'remarks',
}

export function normaliseHeader(raw: string): string {
  let s = raw
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[:：]/g, ' ')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .trim()
  // Glue variants from PDFs/HTML: "U.PRICE(RMB)" → canonical "U.PRICE (RMB)"
  // Also collapse "T. AMOUNT" → "T.AMOUNT" (Reducto sometimes adds a space after the dot)
  s = s
    .replace(/\b([A-Z])\.\s+([A-Z])/g, '$1.$2')
    .replace(/\bU\.PRICE\s*\(/g, 'U.PRICE (')
    .replace(/\bUNIT\s+PRICE\s*\(/g, 'UNIT PRICE (')
    .replace(/\bT\.AMOUNT\s*\(/g, 'T.AMOUNT (')
    .replace(/\bORD\s*NO\.?\b/g, 'ORD NO')
    .replace(/\bDEL\s*NO\.?\b/g, 'DEL NO')
    .replace(/\bCUS\s*NO\.?\b/g, 'CUS NO')
    .replace(/\bITEM\s*NO\.?\b/g, 'ITEM NO')
    .replace(/\bG\.W\.?\b/g, 'G.W')
    .replace(/\bW\.H\.?\b/g, 'W.H')
  return s.replace(/\s+/g, ' ').trim()
}

export function resolveColumn(
  header: string,
  docType: DocType
): ProductField | 'skip' | null {
  const key = normaliseHeader(header)
  const map = docType === 'sales_order' ? SALES_ORDER_COLUMNS : CONTAINER_COLUMNS
  const direct = map[key]
  if (direct) return direct

  if (docType === 'sales_order') {
    if (key.includes('序号') || /^NO\.?$/.test(key) || key.startsWith('NO ')) return 'line_no'
    if (key.includes('ORD NO') || key.includes('DEL NO') || key.includes('销售单号') || key.includes('送货单号')) return 'marks'
    if (key.includes('ITEM NO') || key.includes('产品货号') || key.includes('ITEM CODE')) return 'item_code'
    if (key.includes('DES') || key.includes('描述')) return 'description'
    if (key.includes('CTN') || key.includes('总箱数')) return 'total_cartons'
    if ((key.includes('QTY') && !key.includes('T.QTY')) || key.includes('每箱数量')) return 'packaging'
    if (key.includes('T.QTY') || key.includes('总数量') || key.includes('TOTAL QTY')) return 'total_qty'
    if (key.includes('U/P') || key.includes('单价') || key.includes('UNIT PRICE')) return 'unit_price_rmb'
    if (key.includes('AMOUNT') || key.includes('金额')) return 'total_amount_rmb'
    if (/^L(\s|$)/.test(key) || key.includes(' 长')) return 'dim_l_cm'
    if (/^W(\s|$)/.test(key) || key.includes(' 宽')) return 'dim_w_cm'
    if (/^H(\s|$)/.test(key) || key.includes(' 高')) return 'dim_h_cm'
    if (key.includes('T.T.CBM') || key.includes('总体积') || key.includes('TOTAL CBM')) return 'total_cbm'
    if (key.includes('CBM') || key.includes('体积')) return 'unit_cbm'
    if (key.includes('T.T.KGS') || key.includes('总重量') || key.includes('TOTAL WEIGHT')) return 'total_weight_kg'
    if (key.includes('G.W') || key.includes('重量') || key.includes('UNIT WEIGHT')) return 'unit_weight_kg'
    if (key.includes('条形码') || key.includes('BARCODE') || key.includes('CODE')) return 'barcode'
    if (key.includes('仓位') || key.includes('W.H') || key.includes('WAREHOUSE')) return 'warehouse'
    if (key.includes('REK') || key.includes('备注') || key.includes('REMARKS')) return 'remarks'
    if (key.includes('PHOTO') || key.includes('图片') || key.includes('CUS NO') || key.includes('DATE')) return 'skip'
  }

  return null
}

/** Human-readable column order — used verbatim in system prompts */
export const CONTAINER_COLUMN_ORDER =
  'MARKS | SHOP/IMAGE | ITEM NO | DESCRIPTION | PACKING(qty/ctn) | T.CTN | TOTAL QTY | L(cm) | W(cm) | H(cm) | UNIT CBM | TOTAL CBM | UNIT WEIGHT(KG) | TOTAL WEIGHT(KG) | UNIT PRICE(¥) | TOTAL AMOUNT(¥)'

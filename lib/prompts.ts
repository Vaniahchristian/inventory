export type DocType = 'sales_order' | 'container_manifest' | 'unknown'

export function detectDocType(lines: string[]): DocType {
  const header = lines.slice(0, 25).join(' ')
  if (header.includes('销售单') || header.includes('销售日期')) return 'sales_order'
  if (header.includes('CONTAINER NO') || header.includes('CLIENT DETAILS') || header.includes('SANCARGO')) return 'container_manifest'
  return 'unknown'
}

export function detectDocTypeFromFilename(filename: string): DocType {
  const name = filename.toLowerCase()
  if (name.includes('销售单') || name.includes('sales') || name.includes('order')) return 'sales_order'
  return 'container_manifest'
}

const SHARED_RULES = `
CRITICAL RULES:
- Extract EVERY product row. Do not skip rows with 0 quantities — include them with totals as 0.
- Return ONLY a raw JSON object. No markdown fences, no explanation, no preamble.
- All numeric fields must be plain numbers (floats). Strip units: "0.09CBM" → 0.09, "20.9KGS" → 20.9, "¥32" → 32.
- Use null for any field that is genuinely missing or unreadable.
- Never invent data. If a field is blank in the source, set it to null.
- The "products" array must contain ALL rows found — do not truncate.
`

export function getSalesOrderPrompt(ocrText: string): string {
  return `You are a strict data extraction engine for Chinese sales orders (销售单).

The OCR text below was extracted from a multi-column PDF table.
Columns in the source are: 序号 (line_no), 订单日期 (date), 销售单号 (order_no),
客户货号 (customer_item_no), 产品货号 (item_code), 描述 (description),
总箱数 (total_cartons), 每箱数量 (qty_per_carton), 总数量 (total_qty),
单价 (unit_price), 金额 (total_amount), 长/宽/高 (dimensions cm),
体积 (unit_cbm), 重量 (unit_weight_kg), 总体积 (total_cbm),
总重量 (total_weight_kg), 条形码 (barcode), 备注 (remarks), 仓位 (warehouse).

Return a JSON object with EXACTLY this structure:
{
  "document": {
    "doc_number": "",
    "client_id": "",
    "document_date": "",
    "document_type": "sales_order",
    "footer_totals": {
      "total_cartons": null,
      "total_cbm": null,
      "total_weight_kg": null,
      "total_amount_rmb": null
    }
  },
  "products": [
    {
      "line_no": 1,
      "item_code": "",
      "description": "",
      "qty_per_carton": null,
      "total_cartons": null,
      "total_qty": null,
      "unit_price_rmb": null,
      "total_amount_rmb": null,
      "dim_l_cm": null,
      "dim_w_cm": null,
      "dim_h_cm": null,
      "unit_cbm": null,
      "total_cbm": null,
      "unit_weight_kg": null,
      "total_weight_kg": null,
      "barcode": null,
      "warehouse": null,
      "remarks": null
    }
  ]
}

${SHARED_RULES}

SALES ORDER SPECIFIC:
- item_code is the 产品货号 column (e.g. "CPK-014", "BW20-15/1C", "GS2105-01")
- warehouse is the 仓位 column (e.g. "浦江仓", "东阳仓", "3仓")
- footer_totals: look for a TOTAL row at the bottom of the document with summed values
- document_date format: YYYY-MM-DD

OCR TEXT:
${ocrText}`
}

export function getContainerManifestPrompt(ocrText: string): string {
  return `You are a strict data extraction engine for Chinese container packing lists and manifests.

The OCR text below was extracted from a multi-column PDF table.
Columns in the source are: MARKS (唛头/shipment mark), SHOP# (supplier/shop name),
ITEM NO. (sequence number), DESCRIPTION OF GOODS, PACKING (e.g. "2pcs/ctn"),
T.CTN (total cartons), T.QTY (total pieces), H/W/L (dimensions cm),
UNIT CBM, T.CBM, UNIT WEIGHT (kg), T.WEIGHT (kg), U.PRICE (RMB), T.AMOUNT (RMB),
BOX NO (box number range).

This document may have multiple sections:
- Main shipped goods section
- "GOODS LEFT IN SANCARGO" section (items not shipped)
- Repacked goods from other containers

Return a JSON object with EXACTLY this structure:
{
  "document": {
    "doc_number": "",
    "client_id": "",
    "container_no": "",
    "document_type": "container_manifest",
    "footer_totals": {
      "total_cartons": null,
      "total_cbm": null,
      "total_weight_kg": null,
      "total_amount_rmb": null,
      "total_amount_usd": null,
      "exchange_rate": null,
      "goods_balance_usd": null,
      "freight_usd": null,
      "total_balance_usd": null
    },
    "payments": [
      {
        "payment_date": "",
        "amount_usd": null,
        "payment_type": "deposit"
      }
    ]
  },
  "products": [
    {
      "line_no": 1,
      "marks": "",
      "shop": "",
      "item_code": "",
      "description": "",
      "packaging": "",
      "total_cartons": null,
      "total_qty": null,
      "dim_l_cm": null,
      "dim_w_cm": null,
      "dim_h_cm": null,
      "unit_cbm": null,
      "total_cbm": null,
      "unit_weight_kg": null,
      "total_weight_kg": null,
      "unit_price_rmb": null,
      "total_amount_rmb": null,
      "box_no_start": null,
      "box_no_end": null,
      "section": "shipped",
      "remarks": null
    }
  ]
}

${SHARED_RULES}

CONTAINER MANIFEST SPECIFIC:
- marks: the MARKS/唛头 column (e.g. "37-T-101-1", "MS-301-1")
  MARKS INHERITANCE: Some rows are sub-components or accessories of a parent item and do not repeat
  the MARKS value. Always propagate the most recent MARKS value downward to any sub-row that has
  no MARKS of its own. Never leave marks as null when a preceding row provides a MARKS value.
- shop: the SHOP# column — this is a supplier name (e.g. "佛伦斯", "悠肯", "新南方"), NOT a warehouse
- item_code: use the marks value if no separate item code column exists
- section field must be one of: "shipped", "left_in_warehouse", "repacked"
  - "shipped" = main order rows only (above any yellow section banners)
  - "left_in_warehouse" = rows under "GOODS LEFT IN SANCARGO" / warehouse-left headings
  - "repacked" = rows under "GOODS STUFFED INTO THIS CONTAINER (REPACKED GOODS)" and similar — excluded from inventory like goods-left
- packaging: format "Npcs/ctn" (e.g. "2pcs/ctn", "16pcs/ctn")
- box_no_start / box_no_end: parse from BOX NO column (e.g. "170-278" → start:170, end:278)
- payments: extract all payment lines at the bottom (date, amount, type)
- footer_totals: look for TOTAL row and financial summary at document end

SHARED / MERGED CELLS — CRITICAL FOR ACCURATE CARTON COUNTS:
In this PDF format, a T.CTN value is often a merged cell that visually covers several sub-rows
below it (e.g. "1CTNS" spans rows 2–5 because those items share one physical carton).
OCR will only produce the CTN text once for the group. Rules:
  1. Assign the T.CTN value to the FIRST row of the group (or the row where OCR placed it).
  2. All other sub-rows in that group must have total_cartons set to 0 (not null) so they are
     counted but do not inflate the total.
  3. A sub-row that genuinely has its own separate CTN column value keeps that value.
  4. Rows with 0.000CBM and 0.0KGS are valid — they are parts packed inside the parent carton;
     extract their CBM and weight as 0, not null.
  5. The sum of all total_cartons across every product row must equal the document footer total.

OCR TEXT:
${ocrText}`
}

export function getPromptForDocType(docType: DocType, ocrText: string): string {
  switch (docType) {
    case 'sales_order': return getSalesOrderPrompt(ocrText)
    case 'container_manifest': return getContainerManifestPrompt(ocrText)
    default: return getContainerManifestPrompt(ocrText)
  }
}

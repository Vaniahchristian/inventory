/**
 * Fix 3: Runtime coercion at every LLM→code boundary.
 *
 * LLMs occasionally return numbers as strings ("1950.0"), null as the string
 * "null", or omit optional fields entirely. These functions normalise any raw
 * JSON object into a correctly-typed ExtractedProduct / ExtractedDocument so
 * type errors never silently propagate downstream.
 *
 * Applied in:
 *   - claude-extractor.ts  parseClaudeResponse()
 *   - reducto-client.ts    extractStructuredWithReducto()
 */

import type { ExtractedDocument, ExtractedProduct } from './claude-extractor'

export function coerceProductArray(raw: unknown): ExtractedProduct[] {
  if (!Array.isArray(raw)) return []
  return raw.map(coerceProduct)
}

export function coerceProduct(raw: unknown): ExtractedProduct {
  const p = isObj(raw) ? (raw as Record<string, unknown>) : {}
  return {
    line_no: coerceInt(p['line_no']),
    marks: coerceStr(p['marks']),
    shop: coerceStr(p['shop']),
    item_code: coerceStr(p['item_code']),
    description: coerceStr(p['description']),
    packaging: coerceStr(p['packaging']),
    qty_per_carton: coerceNum(p['qty_per_carton']),
    total_cartons: coerceNum(p['total_cartons']),
    total_qty: coerceNum(p['total_qty']),
    unit_price_rmb: coerceNum(p['unit_price_rmb']),
    total_amount_rmb: coerceNum(p['total_amount_rmb']),
    dim_l_cm: coerceNum(p['dim_l_cm']),
    dim_w_cm: coerceNum(p['dim_w_cm']),
    dim_h_cm: coerceNum(p['dim_h_cm']),
    unit_cbm: coerceNum(p['unit_cbm']),
    total_cbm: coerceNum(p['total_cbm']),
    unit_weight_kg: coerceNum(p['unit_weight_kg']),
    total_weight_kg: coerceNum(p['total_weight_kg']),
    barcode: coerceStr(p['barcode']),
    warehouse: coerceStr(p['warehouse']),
    box_no_start: coerceInt(p['box_no_start']),
    box_no_end: coerceInt(p['box_no_end']),
    section: coerceSection(p['section']),
    remarks: coerceStr(p['remarks']),
  }
}

export function coerceDocument(raw: unknown): ExtractedDocument {
  const d = isObj(raw) ? (raw as Record<string, unknown>) : {}
  const ft = isObj(d['footer_totals']) ? (d['footer_totals'] as Record<string, unknown>) : {}
  return {
    doc_number: coerceStr(d['doc_number']),
    client_id: coerceStr(d['client_id']),
    container_no: coerceStr(d['container_no']),
    document_date: coerceStr(d['document_date']),
    document_type: coerceDocType(d['document_type']),
    footer_totals: {
      total_cartons: coerceNum(ft['total_cartons']),
      total_cbm: coerceNum(ft['total_cbm']),
      total_weight_kg: coerceNum(ft['total_weight_kg']),
      total_amount_rmb: coerceNum(ft['total_amount_rmb']),
      total_amount_usd: coerceNum(ft['total_amount_usd']),
      exchange_rate: coerceNum(ft['exchange_rate']),
      goods_balance_usd: coerceNum(ft['goods_balance_usd']),
      freight_usd: coerceNum(ft['freight_usd']),
      total_balance_usd: coerceNum(ft['total_balance_usd']),
    },
    payments: Array.isArray(d['payments'])
      ? (d['payments'] as unknown[]).flatMap(p => {
          if (!isObj(p)) return []
          const pm = p as Record<string, unknown>
          const amount = coerceNum(pm['amount_usd'])
          if (amount === null) return []
          return [{
            payment_date: coerceStr(pm['payment_date']),
            amount_usd: amount,
            payment_type: coercePaymentType(pm['payment_type']),
          }]
        })
      : [],
  }
}

// ── Primitive coercers ────────────────────────────────────────────────────────

function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[¥￥,%]/g, '').replace(/,/g, '').trim()
    if (cleaned === '' || cleaned === 'null' || cleaned === 'undefined') return null
    const n = parseFloat(cleaned)
    return isFinite(n) ? n : null
  }
  return null
}

function coerceInt(v: unknown): number | null {
  const n = coerceNum(v)
  return n !== null ? Math.round(n) : null
}

function coerceStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' || s === 'null' || s === 'undefined' ? null : s
  }
  return null
}

function coerceSection(v: unknown): ExtractedProduct['section'] {
  if (v === 'left_in_warehouse' || v === 'repacked') return v
  return 'shipped'
}

function coerceDocType(v: unknown): ExtractedDocument['document_type'] {
  if (v === 'sales_order') return 'sales_order'
  if (v === 'container_manifest' || v === 'packing_list') return 'container_manifest'
  return 'unknown'
}

function coercePaymentType(v: unknown): string {
  const valid = ['deposit', 'balance', 'freight', 'credit', 'other']
  if (typeof v === 'string' && valid.includes(v)) return v
  return 'other'
}

function isObj(v: unknown): v is object {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

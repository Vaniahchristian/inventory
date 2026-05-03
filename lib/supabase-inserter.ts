import { ExtractedDocument, ExtractedProduct, ClaudeExtractionResult } from './claude-extractor'
import { isFullExtractBanner } from '@/lib/full-extract'
import { filterToInventoryProducts } from '@/lib/sections'
import { ValidationResult, validateExtraction } from './validator'
import { supabase } from './supabase'

export interface InsertResult {
  document_id: string
  items_inserted: number
  payments_inserted: number
  extraction_run_id: string
}

export async function insertToSupabase(
  fileName: string,
  fileSha256: string | null,
  extraction: ClaudeExtractionResult,
  ocrLines: string[]
): Promise<InsertResult> {
  const doc = extraction.document
  const rawAuditProducts = extraction.products
  const fullProducts = extraction.products.filter(p => !isFullExtractBanner(p))
  if (fullProducts.length === 0) {
    throw new Error('No rows to save — extraction returned no product rows.')
  }
  // Validation uses shipped-only rows (totals cross-check); insertion stores all sections.
  const shippedProducts = filterToInventoryProducts(fullProducts)
  const products = fullProducts
  const validation = validateExtraction(doc, shippedProducts, fullProducts)
  const ft = doc.footer_totals

  // ── 1. Insert document record ─────────────────────────────────────────────
  const { data: documentRow, error: docError } = await supabase
    .from('documents')
    .insert({
      document_type: doc.document_type,
      source_file_name: fileName,
      source_file_sha256: fileSha256,
      doc_number: doc.doc_number,
      client_id: doc.client_id,
      container_no: doc.container_no ?? null,
      document_date: doc.document_date ?? null,
      extraction_status: validation.totals_match ? 'approved' : 'review_needed',
      extraction_confidence: computeOverallConfidence(validation),
      model_name: extraction.model,
      validation_flags: validation.validation_flags,
      raw_extraction: { products: rawAuditProducts, document: doc },
    })
    .select('id')
    .single()

  if (docError) throw new Error(`Document insert failed: ${docError.message}`)
  const document_id = documentRow.id

  console.log(`[supabase] document inserted: ${document_id}`)

  // ── 2. Insert document totals ─────────────────────────────────────────────
  // Physical totals (cartons/CBM/weight): footer covers shipped+repacked, not goods-left
  const physicalProducts = fullProducts.filter(p => (p.section ?? 'shipped') !== 'left_in_warehouse')
  const computedCartons = physicalProducts.reduce((s, p) => s + (p.total_cartons ?? 0), 0)
  const computedQty = physicalProducts.reduce((s, p) => s + (p.total_qty ?? 0), 0)
  const computedCBM = physicalProducts.reduce((s, p) => s + (p.total_cbm ?? 0), 0)
  const computedWeight = physicalProducts.reduce((s, p) => s + (p.total_weight_kg ?? 0), 0)
  // Amount: footer covers all sections including goods-left
  const computedAmount = fullProducts.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0)

  const { error: totalsError } = await supabase.from('document_totals').insert({
    document_id,
    total_cartons: ft.total_cartons,
    total_cbm: ft.total_cbm,
    total_weight_kg: ft.total_weight_kg,
    total_amount_rmb: ft.total_amount_rmb,
    total_amount_usd: ft.total_amount_usd,
    computed_cartons: round(computedCartons),
    computed_quantity: round(computedQty),
    computed_cbm: round(computedCBM),
    computed_weight_kg: round(computedWeight),
    computed_amount_rmb: round(computedAmount),
    totals_match: validation.totals_match,
    totals_diff: validation.totals_diff,
  })
  if (totalsError) throw new Error(`Document totals insert failed: ${totalsError.message}`)

  // ── 3. Bulk insert all product rows ───────────────────────────────────────
  // row_results is produced by products.map() in validator so index matches.
  // We always write sequential line_no (idx+1) to avoid duplicate-key errors
  // when Claude returns two rows with the same line_no across chunk boundaries.
  const itemRows = products.map((p, idx) => {
    const shippedIdx = shippedProducts.indexOf(p)
    const rv = shippedIdx >= 0 ? validation.row_results[shippedIdx] : null
    return {
      document_id,
      line_no: idx + 1,
      marks: p.marks ?? null,
      item_code: p.item_code ?? null,
      description: p.description,
      shop: p.shop ?? null,
      packaging: p.packaging ?? null,
      qty_per_carton: p.qty_per_carton,
      total_cartons: p.total_cartons,
      total_quantity: p.total_qty,
      unit_price_rmb: p.unit_price_rmb,
      total_amount_rmb: p.total_amount_rmb,
      dim_l_cm: p.dim_l_cm,
      dim_w_cm: p.dim_w_cm,
      dim_h_cm: p.dim_h_cm,
      unit_cbm: p.unit_cbm,
      total_cbm: p.total_cbm,
      unit_weight_kg: p.unit_weight_kg,
      total_weight_kg: p.total_weight_kg,
      warehouse: p.warehouse ?? null,
      barcode: p.barcode ?? null,
      box_no_start: p.box_no_start ?? null,
      box_no_end: p.box_no_end ?? null,
      section: p.section ?? 'shipped',
      remarks: p.remarks ?? null,
      extraction_confidence: rv?.confidence ?? 80,
      validation_flags: rv?.flags ?? [],
      source_page: null,
    }
  })

  const { error: itemsError } = await supabase
    .from('document_items')
    .insert(itemRows)

  if (itemsError) throw new Error(`Items insert failed: ${itemsError.message}`)
  console.log(`[supabase] items inserted: ${itemRows.length}`)

  // ── 4. Insert payment records (container manifests only) ──────────────────
  let payments_inserted = 0
  if (doc.payments && doc.payments.length > 0) {
    const paymentRows = doc.payments.map(p => ({
      document_id,
      payment_date: p.payment_date ?? null,
      amount_usd: p.amount_usd,
      payment_type: p.payment_type ?? 'other',
    }))

    const { error: paymentsError } = await supabase
      .from('document_payments')
      .insert(paymentRows)

    if (paymentsError) {
      console.warn('[supabase] payments insert warning:', paymentsError.message)
    } else {
      payments_inserted = paymentRows.length
      console.log(`[supabase] payments inserted: ${payments_inserted}`)
    }
  }

  // ── 5. Log extraction run ─────────────────────────────────────────────────
  const { data: runRow, error: runError } = await supabase
    .from('extraction_runs')
    .insert({
      document_id,
      run_no: 1,
      ai_mode: 'claude_single_call',
      model_name: extraction.model,
      status: 'completed',
      llm_attempts: 1,
        llm_applied: fullProducts.length,
      metrics: {
        input_tokens: extraction.input_tokens,
        output_tokens: extraction.output_tokens,
        truncated: extraction.truncated,
        ocr_lines: ocrLines.length,
        rows_extracted: products.length,
        rows_pass: validation.pass_count,
        rows_flagged: validation.flag_count,
        totals_match: validation.totals_match,
      },
    })
    .select('id')
    .single()
  if (runError) console.warn(`[supabase] extraction_runs insert warning: ${runError.message}`)

  const extraction_run_id = runRow?.id ?? ''

  return {
    document_id,
    items_inserted: itemRows.length,
    payments_inserted,
    extraction_run_id,
  }
}


function computeOverallConfidence(validation: ValidationResult): number {
  if (validation.row_results.length === 0) return 0
  const avg = validation.row_results.reduce((s, r) => s + r.confidence, 0) / validation.row_results.length
  const penalty = validation.totals_match ? 0 : 10
  return Math.max(0, Math.round(avg - penalty))
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

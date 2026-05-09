import { ExtractedDocument, ExtractedProduct, ClaudeExtractionResult } from './claude-extractor'
import { isFullExtractBanner, isSubtotalBanner, isFooterBanner } from '@/lib/full-extract'
import { filterToInventoryProducts, normalizeSectionForStorage } from '@/lib/sections'
import { dedupeShippedCartonCounts, fixManifestSectionContinuity } from '@/lib/manifest-section-fixer'
import type { SectionSubtotal } from '@/lib/reducto-html-parser'
import { ValidationResult, validateExtraction } from './validator'
import { parseFiniteNumber, parseFiniteInt } from './numeric-parse'
import { sanitizeSalesOrderProductsPhysicalCaps } from './sales-order-sanitize'
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
  ocrLines: string[],
  sectionSubtotals?: SectionSubtotal[]
): Promise<InsertResult> {
  const doc = extraction.document
  const rawAuditProducts = extraction.products
  const filtered = extraction.products.filter(
    p => !isFullExtractBanner(p) && !isSubtotalBanner(p) && !isFooterBanner(p)
  )
  if (filtered.length === 0) {
    throw new Error('No rows to save — extraction returned no product rows.')
  }
  const docType = doc.document_type
  const fullProducts = normalizeSalesOrderProducts(
    dedupeShippedCartonCounts(
      fixManifestSectionContinuity(filtered, docType),
      docType
    ),
    doc
  )
  const reconciledProducts = fillMissingRowAmounts(fullProducts)
  // Validation uses shipped-only rows (totals cross-check); insertion stores all sections.
  const shippedProducts = filterToInventoryProducts(reconciledProducts)
  const products = reconciledProducts
  const validation = validateExtraction(doc, shippedProducts, fullProducts)
  const ft = doc.footer_totals

  // ── 1. Insert document record ─────────────────────────────────────────────
  // Same logical extraction → same hash (e.g. Live View save twice). Unique index
  // documents_file_hash_uidx requires replacing the prior row + cascaded children.
  if (fileSha256) {
    const { data: existingDoc, error: existingErr } = await supabase
      .from('documents')
      .select('id')
      .eq('source_file_sha256', fileSha256)
      .maybeSingle()

    if (existingErr) {
      throw new Error(`Document lookup failed: ${existingErr.message}`)
    }
    if (existingDoc?.id) {
      const { error: delErr } = await supabase.from('documents').delete().eq('id', existingDoc.id)
      if (delErr) {
        throw new Error(`Could not replace existing document (duplicate hash): ${delErr.message}`)
      }
      console.log(`[supabase] replaced prior document ${existingDoc.id} (same source_file_sha256)`)
    }
  }

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
  const computedCartons = physicalProducts.reduce(
    (s, p) => s + (parseFiniteNumber(p.total_cartons) ?? 0),
    0
  )
  const computedQty = physicalProducts.reduce((s, p) => s + (parseFiniteNumber(p.total_qty) ?? 0), 0)
  const computedCBM = physicalProducts.reduce((s, p) => s + (parseFiniteNumber(p.total_cbm) ?? 0), 0)
  const computedWeight = physicalProducts.reduce(
    (s, p) => s + (parseFiniteNumber(p.total_weight_kg) ?? 0),
    0
  )
  // Amount: footer covers all sections including goods-left.
  const computedAmount = fullProducts.reduce(
    (s, p) => s + (parseFiniteNumber(p.total_amount_rmb) ?? 0),
    0
  )

  // Per-section aggregates for comparison against PDF yellow-bar subtotals.
  // Physical metrics for left_in_warehouse are zeroed by design (not shipped), so only
  // compare their amount. Shipped and repacked compare all four metrics.
  const sectionAggs: Record<string, { cartons: number; cbm: number; weight: number; amount: number }> = {}
  for (const p of fullProducts) {
    const sec = p.section ?? 'shipped'
    if (!sectionAggs[sec]) sectionAggs[sec] = { cartons: 0, cbm: 0, weight: 0, amount: 0 }
    sectionAggs[sec].cartons += parseFiniteNumber(p.total_cartons) ?? 0
    sectionAggs[sec].cbm += parseFiniteNumber(p.total_cbm) ?? 0
    sectionAggs[sec].weight += parseFiniteNumber(p.total_weight_kg) ?? 0
    sectionAggs[sec].amount += parseFiniteNumber(p.total_amount_rmb) ?? 0
  }

  const sectionComparison: Record<string, object> = {}
  if (sectionSubtotals && sectionSubtotals.length > 0) {
    // Use last bar per section — for left_in_warehouse that's GOODS LEFT (BEFORE GOODS already filtered at parse time).
    const lastBarBySection: Record<string, typeof sectionSubtotals[0]> = {}
    for (const bar of sectionSubtotals) lastBarBySection[bar.section] = bar

    for (const [sec, bar] of Object.entries(lastBarBySection)) {
      const agg = sectionAggs[sec] ?? { cartons: 0, cbm: 0, weight: 0, amount: 0 }
      const isWarehouse = sec === 'left_in_warehouse'
      sectionComparison[sec] = isWarehouse
        ? {
            computed_amount_rmb: round(agg.amount),
            pdf_amount_rmb: bar.total_amount_rmb,
          }
        : {
            computed_cartons: round(agg.cartons),
            computed_cbm: round(agg.cbm),
            computed_weight_kg: round(agg.weight),
            computed_amount_rmb: round(agg.amount),
            pdf_cartons: bar.total_cartons,
            pdf_cbm: bar.total_cbm,
            pdf_weight_kg: bar.total_weight_kg,
            pdf_amount_rmb: bar.total_amount_rmb,
          }
    }
  }

  const { error: totalsError } = await supabase.from('document_totals').insert({
    document_id,
    total_cartons: parseFiniteNumber(ft.total_cartons),
    total_cbm: parseFiniteNumber(ft.total_cbm),
    total_weight_kg: parseFiniteNumber(ft.total_weight_kg),
    total_amount_rmb: parseFiniteNumber(ft.total_amount_rmb),
    total_amount_usd: parseFiniteNumber(ft.total_amount_usd),
    computed_cartons: round(computedCartons),
    computed_quantity: round(computedQty),
    computed_cbm: round(computedCBM),
    computed_weight_kg: round(computedWeight),
    computed_amount_rmb: round(computedAmount),
    totals_match: validation.totals_match,
    totals_diff: {
      ...validation.totals_diff,
      ...(Object.keys(sectionComparison).length > 0 ? { sections: sectionComparison } : {}),
      ...(sectionSubtotals && sectionSubtotals.length > 0 ? { section_subtotals: sectionSubtotals } : {}),
    },
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
      qty_per_carton: parseFiniteNumber(p.qty_per_carton),
      total_cartons: parseFiniteNumber(p.total_cartons),
      total_quantity: parseFiniteNumber(p.total_qty),
      unit_price_rmb: parseFiniteNumber(p.unit_price_rmb),
      total_amount_rmb: parseFiniteNumber(p.total_amount_rmb),
      dim_l_cm: parseFiniteNumber(p.dim_l_cm),
      dim_w_cm: parseFiniteNumber(p.dim_w_cm),
      dim_h_cm: parseFiniteNumber(p.dim_h_cm),
      unit_cbm: parseFiniteNumber(p.unit_cbm),
      total_cbm: parseFiniteNumber(p.total_cbm),
      unit_weight_kg: parseFiniteNumber(p.unit_weight_kg),
      total_weight_kg: parseFiniteNumber(p.total_weight_kg),
      warehouse: p.warehouse ?? null,
      barcode: p.barcode ?? null,
      box_no_start: parseFiniteInt(p.box_no_start),
      box_no_end: parseFiniteInt(p.box_no_end),
      section: normalizeSectionForStorage(p.section, p.remarks),
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
      amount_usd: parseFiniteNumber(p.amount_usd),
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

function fillMissingRowAmounts(products: ExtractedProduct[]): ExtractedProduct[] {
  return products.map(p => {
    const qty = p.total_qty ?? 0
    const unit = p.unit_price_rmb ?? 0
    const amount = p.total_amount_rmb
    if (qty <= 0 || unit <= 0 || (amount ?? 0) > 0) return p
    // Keep explicit carryover-ignored rows null by design.
    if ((p.remarks ?? '').includes('repair:before_goods_amount_carryover_ignored')) return p
    return {
      ...p,
      total_amount_rmb: round(qty * unit),
      remarks: p.remarks
        ? `${p.remarks};repair:amount_from_qty_price`
        : 'repair:amount_from_qty_price',
    }
  })
}

function normalizeSalesOrderProducts(
  products: ExtractedProduct[],
  doc: ExtractedDocument
): ExtractedProduct[] {
  if (doc.document_type !== 'sales_order') return products

  const out = sanitizeSalesOrderProductsPhysicalCaps(products.map(p => ({ ...p })))
  const normCode = (code: string | null | undefined): string => (code ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
  const codeStem = (code: string | null | undefined): string => {
    const c = normCode(code)
    if (!c) return ''
    return c.replace(/-[A-Z0-9]+$/, '').slice(0, 5) || c.slice(0, 5)
  }
  const descTokens = (desc: string | null | undefined): string[] =>
    (desc ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9.\s"]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3)

  const donorRows = out.filter(p => (p.unit_price_rmb ?? 0) > 0 && (p.total_qty ?? 0) > 0)
  const isQtyPlausible = (p: ExtractedProduct): boolean => {
    const qty = p.total_qty ?? 0
    if (qty <= 0) return false
    const cartons = p.total_cartons ?? 0
    const ppc = p.qty_per_carton ?? 0
    if (cartons > 0 && ppc > 0) {
      const expected = cartons * ppc
      if (expected <= 0) return false
      const ratio = qty / expected
      // Accept near-exact qty; reject known OCR explosions like 60->660.
      return ratio >= 0.8 && ratio <= 1.25
    }
    return true
  }
  const inferQtyFromAmount = (p: ExtractedProduct): number | null => {
    const amount = p.total_amount_rmb ?? 0
    const price = p.unit_price_rmb ?? 0
    if (amount <= 0 || price <= 0) return null
    const q = amount / price
    const rq = Math.round(q)
    if (!Number.isFinite(q) || rq <= 0) return null
    if (Math.abs(q - rq) > 0.02) return null
    return rq
  }
  const looksLikeBorrowedPhysical = (p: ExtractedProduct): boolean => {
    const amount = p.total_amount_rmb ?? 0
    if (amount <= 0) return false
    const weight = p.total_weight_kg ?? null
    const cbm = p.total_cbm ?? null
    if (weight !== null && Math.abs(amount - weight) <= 0.2) return true
    if (cbm !== null && Math.abs(amount - cbm) <= 0.02) return true
    return false
  }

  // If qty appears noisy but amount+price are coherent, restore qty from amount.
  for (const p of out) {
    const inferredQty = inferQtyFromAmount(p)
    if (inferredQty === null) continue
    const qty = p.total_qty ?? 0
    if (qty <= 0 || qty === inferredQty) {
      p.total_qty = inferredQty
      continue
    }
    if (qty > inferredQty * 2) {
      p.total_qty = inferredQty
    }
  }

  // Fill missing row amount when qty and unit price exist and qty is plausible.
  for (const p of out) {
    const qty = p.total_qty ?? 0
    const price = p.unit_price_rmb ?? 0
    const amount = p.total_amount_rmb ?? 0
    if (qty > 0 && price > 0 && amount <= 0 && isQtyPlausible(p)) {
      p.total_amount_rmb = round(qty * price)
    }
  }

  // If unit price is missing (or amount looks copied from physical columns),
  // infer from similar rows and derive amount.
  for (const p of out) {
    const qty = p.total_qty ?? 0
    const amount = p.total_amount_rmb ?? 0
    const needsRepair = amount <= 0 || looksLikeBorrowedPhysical(p)
    if (qty <= 0 || !needsRepair || (p.unit_price_rmb ?? 0) > 0) continue

    const pStem = codeStem(p.item_code)
    const pTokens = new Set(descTokens(p.description))
    const ppc = p.qty_per_carton ?? 0

    const scored = donorRows
      .map(d => {
        const dStem = codeStem(d.item_code)
        const dTokens = descTokens(d.description)
        const overlap = dTokens.filter(t => pTokens.has(t)).length
        let score = 0
        if (pStem && dStem && pStem === dStem) score += 4
        if (overlap >= 2) score += 3
        if (ppc > 0 && (d.qty_per_carton ?? 0) > 0 && Math.abs((d.qty_per_carton ?? 0) - ppc) <= 2)
          score += 1
        return { score, price: d.unit_price_rmb ?? 0 }
      })
      .filter(s => s.score >= 3 && s.price > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue
    const inferredPrice = scored[0].price
    p.unit_price_rmb = inferredPrice
    p.total_amount_rmb = round(qty * inferredPrice)
  }

  // Final guard: correct clearly borrowed physical values (amount ~= kg/cbm)
  // only when qty is plausible for the carton/packing structure.
  for (const p of out) {
    const qty = p.total_qty ?? 0
    const price = p.unit_price_rmb ?? 0
    const amount = p.total_amount_rmb ?? 0
    if (qty <= 0 || price <= 0) continue
    const expected = round(qty * price)
    const drift = Math.abs(amount - expected)
    const severeDrift = drift > Math.max(5, expected * 0.25)
    if (
      amount <= 0 ||
      (severeDrift && looksLikeBorrowedPhysical(p) && isQtyPlausible(p))
    ) {
      p.total_amount_rmb = expected
    }
  }

  const footerCartons = doc.footer_totals.total_cartons ?? null
  if (footerCartons === null || footerCartons <= 0) return out

  const computedCartons = out.reduce((s, p) => s + (parseFiniteNumber(p.total_cartons) ?? 0), 0)
  let overflow = computedCartons - footerCartons
  if (overflow <= 0) return out

  // Reconcile known OCR artifact: carton count inflated compared to qty/ctn.
  // Limit to higher qty-per-carton rows where this pattern appears frequently.
  const candidates = out
    .map((p, idx) => {
      const ctn = p.total_cartons ?? 0
      const qty = p.total_qty ?? 0
      const ppc = p.qty_per_carton ?? 0
      if (ctn <= 0 || qty <= 0 || ppc < 24) return null
      const inferred = qty / ppc
      const rounded = Math.round(inferred)
      if (!Number.isFinite(inferred) || rounded <= 0) return null
      if (Math.abs(inferred - rounded) > 0.02) return null
      if (rounded >= ctn) return null
      const reduction = ctn - rounded
      if (reduction < 4) return null
      return { idx, rounded, reduction, lineNo: p.line_no ?? idx + 1 }
    })
    .filter((v): v is { idx: number; rounded: number; reduction: number; lineNo: number } => v !== null)
    .sort((a, b) => (b.reduction - a.reduction) || (b.lineNo - a.lineNo))

  for (const c of candidates) {
    if (overflow <= 0) break
    if (c.reduction > overflow) continue
    out[c.idx].total_cartons = c.rounded
    overflow -= c.reduction
  }

  return out
}

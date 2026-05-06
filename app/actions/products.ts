'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'
import type { ImportMeta, ProductDocumentRef } from '@/lib/types'
import { REPACKAGED_SECTION_MARKER_SKU, REPACKAGED_SECTION_TITLE, STAGE_SECTION_MARKER_PREFIX, STAGE_TOTAL_MARKER_PREFIX, isRepackagedSectionHeader, isGoodsLeftHeader, isValidStageSectionTitle, makeStageTotalSku } from '@/lib/sections'
import Anthropic from '@anthropic-ai/sdk'
import { callLlm } from '@/lib/llm-client'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

/** Terminal logs when importing: dev server, or set DEBUG_PRODUCT_IMPORT=1 / NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT=1 */
function importDebug(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.DEBUG_PRODUCT_IMPORT === '1' ||
    process.env.NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT === '1'
  )
}

function logImport(...args: unknown[]) {
  if (importDebug()) console.log('[product-import]', ...args)
}

function isTransientFetchError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('fetch failed') || m.includes('network') || m.includes('etimedout')
}                                                                                                         

async function withSupabaseRetry<T>(run: () => PromiseLike<T>, label: string, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await run()
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!isTransientFetchError(msg) || i === attempts - 1) break
      const backoffMs = 300 * (i + 1)
      logImport(`supabase transient error on ${label}, retry ${i + 1}/${attempts} in ${backoffMs}ms:`, msg)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
  throw lastError
}

type LlmAlignedRow = {
  name: string | null
  description: string | null
  shop_name: string | null
  packing: string | null
  cartons: number | null
  quantity: number | null
  unit_cbm: number | null
  cbm: number | null
  unit_weight: string | null
  total_weight: string | null
  cost_price: number | null
  total_amount_rmb: number | null
}

const DOCUMENT_ITEM_SELECT = [
  'id',
  'document_id',
  'line_no',
  'marks',
  'item_code',
  'description',
  'shop',
  'packaging',
  'total_cartons',
  'total_quantity',
  'unit_price_rmb',
  'total_amount_rmb',
  'dim_l_cm',
  'dim_w_cm',
  'dim_h_cm',
  'unit_cbm',
  'total_cbm',
  'unit_weight_kg',
  'total_weight_kg',
  'warehouse',
  'barcode',
  'box_no_start',
  'box_no_end',
  'section',
  'remarks',
  'created_at',
  'documents(source_file_name, client_id, container_no, document_date, doc_number)',
].join(', ')

type ImportValidationFlag =
  | 'missing_packing'
  | 'missing_name'
  | 'qty_without_cartons'
  | 'cartons_without_qty'
  | 'amount_mismatch'
  | 'price_missing_but_amount_present'
  | 'zero_qty_and_zero_cartons'

type MappedRow = {
  sku: string | null
  source_item_no?: string | null
  name: string | null
  description: string | null
  shop_name: string | null
  unit: string
  packing: string | null
  cartons: number | null
  quantity: number
  unit_cbm: number | null
  cbm: number | null
  unit_weight: string | null
  total_weight: string | null
  dim_l_cm?: number | null
  dim_w_cm?: number | null
  dim_h_cm?: number | null
  cost_price: number
  total_amount_rmb: number | null
  warehouse?: string | null
  remarks?: string | null
  barcode?: string | null
  code?: string | null
  photo?: string | null
  photo2?: string | null
  order_no?: string | null
  customer_no?: string | null
  delivery_address?: string | null
  document_date?: string | null
  selling_price: number
  reorder_level: number
}

type LlmCandidate = {
  mappedIndex: number
  raw: Record<string, unknown>
  sku: string | null
}

type ValidationSummary = {
  totalRows: number
  flaggedRows: number
  criticalRows: number
  flagCounts: Record<string, number>
  qualityScore: number
  shouldReview: boolean
  shouldHardFail: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function computeValidationFlags(
  row: MappedRow,
  options: { requirePacking?: boolean } = {}
): ImportValidationFlag[] {
  const flags: ImportValidationFlag[] = []
  const requirePacking = options.requirePacking ?? true
  const cartons = row.cartons ?? 0
  const qty = row.quantity
  const price = row.cost_price
  const amount = row.total_amount_rmb ?? 0
  if (!row.name) flags.push('missing_name')
  if (requirePacking && !row.packing) flags.push('missing_packing')
  if (qty > 0 && cartons <= 0) flags.push('qty_without_cartons')
  if (cartons > 0 && qty <= 0) flags.push('cartons_without_qty')
  if (price <= 0 && amount > 0) flags.push('price_missing_but_amount_present')
  if (qty === 0 && cartons === 0) flags.push('zero_qty_and_zero_cartons')
  if (qty > 0 && price > 0 && amount > 0) {
    const expected = qty * price
    const delta = Math.abs(expected - amount)
    const tolerance = Math.max(5, expected * 0.02)
    if (delta > tolerance) flags.push('amount_mismatch')
  }
  return flags
}

function summarizeValidation(
  mapped: MappedRow[],
  options: { requirePacking?: boolean } = {}
): ValidationSummary {
  const flagCounts: Record<string, number> = {}
  const dataRows = mapped.filter(
    row =>
      !((row.sku ?? '').startsWith(STAGE_SECTION_MARKER_PREFIX) ||
        (row.sku ?? '').startsWith(STAGE_TOTAL_MARKER_PREFIX) ||
        (row.sku ?? '') === REPACKAGED_SECTION_MARKER_SKU)
  )
  let flaggedRows = 0
  let criticalRows = 0
  for (const row of dataRows) {
    const flags = computeValidationFlags(row, options)
    if (flags.length > 0) flaggedRows++
    const critical = flags.some(f => f === 'missing_name' || f === 'missing_packing' || f === 'amount_mismatch')
    if (critical) criticalRows++
    for (const f of flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1
  }
  const totalRows = Math.max(1, dataRows.length)
  const flaggedRatio = flaggedRows / totalRows
  const criticalRatio = criticalRows / totalRows
  const qualityScore = Math.max(0, Math.round(100 - flaggedRatio * 35 - criticalRatio * 65))
  const hardFailThreshold = Number(process.env.IMPORT_HARD_FAIL_CRITICAL_RATIO ?? 0.45)
  const reviewThreshold = Number(process.env.IMPORT_REVIEW_FLAGGED_RATIO ?? 0.1)
  return {
    totalRows,
    flaggedRows,
    criticalRows,
    flagCounts,
    qualityScore,
    shouldReview: flaggedRatio >= reviewThreshold || criticalRows > 0,
    shouldHardFail: criticalRatio >= hardFailThreshold,
  }
}

async function saveExtractionAudit(payload: {
  import_meta: ImportMeta | null | undefined
  ai_mode: string
  llm_attempts: number
  llm_aligned: number
  totals_match: boolean
  totals_diff: Record<string, number | null> | null
  validation_flag_counts: Record<string, number>
  sample_rows: Array<{
    sku: string | null
    quantity: number
    cartons: number | null
    packing: string | null
    cost_price: number
    total_amount_rmb: number | null
    flags: ImportValidationFlag[]
  }>
}) {
  try {
    const { error } = await withSupabaseRetry(
      () =>
        supabase.from('product_import_audit').insert({
          source_file_name: payload.import_meta?.source_file_name ?? null,
          source_file_type: payload.import_meta?.source_file_type ?? null,
          client_details: payload.import_meta?.client_details ?? null,
          container_no: payload.import_meta?.container_no ?? null,
          ai_mode: payload.ai_mode,
          llm_attempts: payload.llm_attempts,
          llm_aligned: payload.llm_aligned,
          totals_match: payload.totals_match,
          totals_diff: payload.totals_diff,
          validation_flag_counts: payload.validation_flag_counts,
          sample_rows: payload.sample_rows,
        }),
      'saveExtractionAudit'
    )
    if (error) logImport('saveExtractionAudit skipped:', error.message)
  } catch (err: any) {
    logImport('saveExtractionAudit exception:', err?.message ?? err)
  }
}

function shouldUseLlmAlignment(raw: Record<string, unknown>, mapped: {
  packing: string | null
  cartons: number | null
  quantity: number
  cost_price: number
}): boolean {
  // Respect the parser's explicit signal when it couldn't extract critical fields
  if (raw['__needs_llm'] === 'true') return true
  const packingLooksBad = !mapped.packing || !/\d+\s*[a-zA-Z]+\s*\/\s*ctn/i.test(mapped.packing)
  const rawCartons = intOrNull(raw['T.CTN']) ?? 0
  const rawQty = intOrNull(raw['T.QTY']) ?? 0
  const rawAmount = num(raw['T.AMOUNT'])
  // Only suspicious if quantity is zero while cartons suggest there should be stock.
  const qtySuspicious = mapped.quantity <= 0 && (mapped.cartons ?? rawCartons) > 0
  // Only suspicious if price is zero but total amount indicates paid value.
  const priceSuspicious = mapped.cost_price <= 0 && rawAmount > 0 && rawQty > 0
  const shiftedSignal = !!str(raw['PACKING'] ?? '') && !/\//.test(str(raw['PACKING'] ?? ''))
  return packingLooksBad || qtySuspicious || priceSuspicious || shiftedSignal
}

function sanitizeAlignedText(v: string | null): string | null {
  if (!v) return null
  return v.replace(/\bSANCARGO\b/gi, '').replace(/\s+/g, ' ').trim() || null
}

function hasMeaningfulLlmImprovement(
  before: { packing: string | null; quantity: number; cost_price: number; name: string | null; shop_name: string | null },
  after: { packing: string | null; quantity: number; cost_price: number; name: string | null; shop_name: string | null }
): boolean {
  const packingImproved = (!!after.packing && /\//.test(after.packing)) && after.packing !== before.packing
  const qtyImproved = after.quantity > 0 && after.quantity !== before.quantity
  const priceImproved = after.cost_price > 0 && after.cost_price !== before.cost_price
  const textImproved = (!!after.name && after.name !== before.name) || (!!after.shop_name && after.shop_name !== before.shop_name)
  return packingImproved || qtyImproved || priceImproved || textImproved
}

function parseLlmJson(text: string): LlmAlignedRow | null {
  const cleaned = text.trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? cleaned
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const json = fenced.slice(start, end + 1)
  try {
    const parsed = JSON.parse(json)
    return {
      name: str(parsed.name) || null,
      description: str(parsed.description) || null,
      shop_name: str(parsed.shop_name) || null,
      packing: str(parsed.packing) || null,
      cartons: intOrNull(parsed.cartons),
      quantity: intOrNull(parsed.quantity),
      unit_cbm: numOrNull(parsed.unit_cbm),
      cbm: numOrNull(parsed.cbm),
      unit_weight: str(parsed.unit_weight) || null,
      total_weight: str(parsed.total_weight) || null,
      cost_price: numOrNull(parsed.cost_price),
      total_amount_rmb: numOrNull(parsed.total_amount_rmb),
    }
  } catch {
    return null
  }
}

async function alignPackingRowWithLlm(raw: Record<string, unknown>): Promise<LlmAlignedRow | null> {
  // Build OCR context window: find the lines around this row's MARKS token
  const allOcrLines = str(raw['__ocr_lines'] ?? '').split('\n').filter(Boolean)
  const ocrContext = (() => {
    if (!allOcrLines.length) return ''
    const marksFirst = str(raw['MARKS'] ?? '').split('\n')[0].trim().toUpperCase()
    const matchIdx = marksFirst
      ? allOcrLines.findIndex(l => l.toUpperCase().includes(marksFirst))
      : -1
    const start = matchIdx !== -1 ? Math.max(0, matchIdx - 4) : 0
    const end = matchIdx !== -1 ? Math.min(allOcrLines.length, matchIdx + 8) : Math.min(allOcrLines.length, 12)
    return allOcrLines.slice(start, end).join('\n')
  })()

  const { __ocr_lines: _ocr, ...rawWithoutOcr } = raw as Record<string, unknown> & { __ocr_lines?: unknown }

  const prompt = [
    'Extract one packing-list row into strict JSON.',
    'Return ONLY a single JSON object with keys:',
    'name, description, shop_name, packing, cartons, quantity, unit_cbm, cbm, unit_weight, total_weight, cost_price, total_amount_rmb',
    'Rules:',
    '- Keep numbers numeric (no currency symbols).',
    '- packing format like "16pcs/ctn" when possible.',
    '- If unknown, use null.',
    '- Do not include markdown or extra text.',
    `Input row: ${JSON.stringify(rawWithoutOcr)}`,
    ocrContext ? `\nOCR source text (find values missing from the row above):\n${ocrContext}` : '',
  ].filter(Boolean).join('\n')

  logImport('Claude request row:', {
    MARKS: str(raw['MARKS']).slice(0, 60),
    PACKING: raw['PACKING'],
    'T.CTN': raw['T.CTN'],
    'T.QTY': raw['T.QTY'],
    'U.PRICE (RMB)': raw['U.PRICE (RMB)'],
  })

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: `You are a strict data extraction engine. Output JSON only.\n\n${prompt}` }],
  })

  const content = response.content[0].type === 'text' ? response.content[0].text : ''
  if (!content) {
    logImport('Claude returned empty response')
    return null
  }

  logImport('Claude raw content preview:', content.slice(0, 500))
  const parsed = parseLlmJson(content)
  logImport('Claude parsed JSON:', parsed)
  return parsed
}

export async function getProducts() {
  const [manualRes, docLinkedRes] = await Promise.all([
    withSupabaseRetry(
      () =>
        supabase
          .from('products')
          .select('*, suppliers(id,name)')
          .is('source_document_id', null),
      'getProducts.manual'
    ),
    withSupabaseRetry(
      () =>
        supabase
          .from('products')
          .select('*, suppliers(id,name)')
          .not('source_document_id', 'is', null),
      'getProducts.docLinked'
    ),
  ])
  if (manualRes.error) throw new Error(manualRes.error.message)
  if (docLinkedRes.error) throw new Error(docLinkedRes.error.message)

  const manualRows = manualRes.data
  const docLinkedRows = docLinkedRes.data
  const merged = [...(manualRows ?? []), ...(docLinkedRows ?? [])]
  return merged.sort(
    (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  )
}

export async function getLatestImportMeta() {
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('product_import_meta')
        .select('*')
        .eq('id', 1)
        .maybeSingle(),
    'getLatestImportMeta'
  )
  if (error) {
    // Metadata is optional; do not fail the products page on RLS/policy issues.
    logImport('getLatestImportMeta skipped:', error.message)
    return null
  }
  return data as ImportMeta | null
}

export type DocumentFooterPaymentRow = {
  label: string
  value: string
  highlight?: boolean
}

export type DocumentImportMetaBundle = {
  meta: ImportMeta
  /** Render right-column fees/payments from DB (document_payments). */
  paymentRows: DocumentFooterPaymentRow[]
}

function formatDdMmYyyy(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim())
  if (!m) return isoDate
  return `${m[3]}/${m[2]}/${m[1]}`
}

function fmtUsdAmount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Footer totals + payments for one document (documents / document_totals / document_payments). */
export async function getDocumentImportMeta(documentId: string): Promise<DocumentImportMetaBundle | null> {
  const { data: doc, error: docErr } = await withSupabaseRetry(
    () =>
      supabase
        .from('documents')
        .select('id, source_file_name, client_name, client_id, container_no, document_type')
        .eq('id', documentId)
        .maybeSingle(),
    'getDocumentImportMeta.doc'
  )
  if (docErr || !doc) return null

  const [{ data: totals }, { data: payments }] = await Promise.all([
    withSupabaseRetry(
      () =>
        supabase.from('document_totals').select('*').eq('document_id', documentId).maybeSingle(),
      'getDocumentImportMeta.totals'
    ),
    withSupabaseRetry(
      () =>
        supabase
          .from('document_payments')
          .select('payment_date, amount_usd, payment_type, note')
          .eq('document_id', documentId)
          .order('payment_date', { ascending: true }),
      'getDocumentImportMeta.payments'
    ),
  ])

  const name = doc.source_file_name ?? ''
  const lower = name.toLowerCase()
  const source_file_type: 'pdf' | 'excel_or_csv' = lower.endsWith('.pdf') ? 'pdf' : 'excel_or_csv'

  const meta: ImportMeta = {
    source_file_name: name || 'document',
    source_file_type,
    document_type: doc.document_type as ImportMeta['document_type'],
    client_details: doc.client_name ?? doc.client_id ?? null,
    container_no: doc.container_no ?? null,
    total_weight_kgs: totals?.total_weight_kg != null ? Number(totals.total_weight_kg) : null,
    total_cbm: totals?.total_cbm != null ? Number(totals.total_cbm) : null,
    total_carton: totals?.total_cartons != null ? Number(totals.total_cartons) : null,
    total_cost_rmb: totals?.total_amount_rmb != null ? Number(totals.total_amount_rmb) : null,
    total_cost_usd: totals?.total_amount_usd != null ? Number(totals.total_amount_usd) : null,
    payment_date: null,
    payment_usd: null,
    goods_balance_usd: null,
    credit_support_usd: null,
    pivoc_usd: null,
    freight_usd: null,
    total_balance_usd: null,
    exchange_rate: null,
  }

  const paymentRows: DocumentFooterPaymentRow[] = []
  for (const p of payments ?? []) {
    const amt = p.amount_usd != null ? Number(p.amount_usd) : null
    const val = amt != null ? `$${fmtUsdAmount(amt)} USD` : '-'
    const t = p.payment_type ?? ''
    const note = (p.note ?? '').trim()

    if (t === 'freight') {
      meta.freight_usd = amt
      paymentRows.push({ label: 'YIWU-MOMBASA FREIGHT', value: val })
      continue
    }
    if (t === 'credit') {
      meta.credit_support_usd = amt
      paymentRows.push({ label: 'CREDIT SUPPORT TO MOMBASA', value: val })
      continue
    }
    if (t === 'other') {
      meta.pivoc_usd = amt
      const lab = /PIVOC/i.test(note) ? 'PIVOC' : note || 'Other'
      paymentRows.push({ label: lab, value: val })
      continue
    }
    if (t === 'deposit' || t === 'balance') {
      if (p.payment_date) {
        const d = formatDdMmYyyy(String(p.payment_date))
        paymentRows.push({
          label: `${d} PAYMENT`,
          value: val,
          highlight: t === 'balance',
        })
        if (!meta.payment_date) {
          meta.payment_date = d
          meta.payment_usd = amt
        }
      } else {
        paymentRows.push({
          label: t === 'balance' ? 'BALANCE PAYMENT' : 'PAYMENT',
          value: val,
          highlight: t === 'balance',
        })
      }
      continue
    }
    paymentRows.push({
      label: note || t || 'Payment',
      value: val,
    })
  }

  return { meta, paymentRows }
}

export async function getProductDocuments(): Promise<ProductDocumentRef[]> {
  const { data: productRows, error: prodErr } = await withSupabaseRetry(
    () =>
      supabase.from('products').select('source_document_id').not('source_document_id', 'is', null),
    'getProductDocuments.productIds'
  )
  if (prodErr) throw new Error(prodErr.message)

  const docIdSet = new Set<string>()
  for (const r of productRows ?? []) {
    const id = (r as { source_document_id?: string | null }).source_document_id
    if (typeof id === 'string' && id.length > 0) docIdSet.add(id)
  }
  const docIds = [...docIdSet]
  if (docIds.length === 0) return []

  const chunkSize = 80
  const byId = new Map<string, ProductDocumentRef & { created_at: string }>()
  for (let i = 0; i < docIds.length; i += chunkSize) {
    const chunk = docIds.slice(i, i + chunkSize)
    const { data: rows, error } = await withSupabaseRetry(
      () =>
        supabase
          .from('documents')
          .select('id, source_file_name, document_type, extraction_status, publish_state, created_at')
          .in('id', chunk),
      'getProductDocuments.documents'
    )
    if (error) throw new Error(error.message)
    for (const row of rows ?? []) {
      const rec = row as ProductDocumentRef & { created_at: string }
      if (rec.id && !byId.has(rec.id)) byId.set(rec.id, rec)
    }
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  )
  return merged.slice(0, 300)
}

export async function createProduct(formData: FormData) {
  const imageFile = formData.get('image') as File | null
  let image_url: string | null = null

  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()
    const path = `${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('product-images')
      .upload(path, imageFile, { upsert: true })
    if (!upErr) {
      const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path)
      image_url = pub.publicUrl
    }
  }

  const { error } = await supabase.from('products').insert({
    name: (formData.get('name') as string) || null,
    sku: (formData.get('sku') as string) || null,
    description: (formData.get('description') as string) || null,
    supplier_id: (formData.get('supplier_id') as string) || null,
    unit: (formData.get('unit') as string) || 'pcs',
    shop_name: (formData.get('shop_name') as string) || null,
    packing: (formData.get('packing') as string) || null,
    cartons: intOrNull(formData.get('cartons')),
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
    unit_cbm: numOrNull(formData.get('unit_cbm')),
    cbm: numOrNull(formData.get('cbm')),
    unit_weight: (formData.get('unit_weight') as string) || null,
    total_weight: (formData.get('total_weight') as string) || null,
    total_amount_rmb: numOrNull(formData.get('total_amount_rmb')),
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
    image_url,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function updateProduct(id: string, formData: FormData) {
  const imageFile = formData.get('image') as File | null
  let image_url: string | undefined

  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()
    const path = `${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('product-images')
      .upload(path, imageFile, { upsert: true })
    if (!upErr) {
      const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path)
      image_url = pub.publicUrl
    }
  }

  const update: Record<string, unknown> = {
    name: (formData.get('name') as string) || null,
    sku: (formData.get('sku') as string) || null,
    description: (formData.get('description') as string) || null,
    supplier_id: (formData.get('supplier_id') as string) || null,
    unit: (formData.get('unit') as string) || 'pcs',
    shop_name: (formData.get('shop_name') as string) || null,
    packing: (formData.get('packing') as string) || null,
    cartons: intOrNull(formData.get('cartons')),
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
    unit_cbm: numOrNull(formData.get('unit_cbm')),
    cbm: numOrNull(formData.get('cbm')),
    unit_weight: (formData.get('unit_weight') as string) || null,
    total_weight: (formData.get('total_weight') as string) || null,
    total_amount_rmb: numOrNull(formData.get('total_amount_rmb')),
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
  }
  if (image_url !== undefined) update.image_url = image_url

  const { error } = await supabase.from('products').update(update).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function markOutOfStock(id: string) {
  const { error } = await supabase.from('products').update({ cartons: 0, quantity: 0 }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function adjustProductCartons(id: string, delta: number) {
  const { data } = await supabase.from('products').select('cartons').eq('id', id).single()
  const current = data?.cartons ?? 0
  const next = Math.max(0, current + delta)
  const { error } = await supabase.from('products').update({ cartons: next }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function adjustDocumentItemCartons(id: string, delta: number) {
  const { data } = await withSupabaseRetry(
    () => supabase.from('document_items').select('total_cartons').eq('id', id).single(),
    'adjustDocumentItemCartons.select'
  )
  const current = data?.total_cartons ?? 0
  const next = Math.max(0, current + delta)
  const { error } = await withSupabaseRetry(
    () => supabase.from('document_items').update({ total_cartons: next }).eq('id', id),
    'adjustDocumentItemCartons.update'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/compiled-products')
  revalidatePath('/products')
}

export async function markDocumentItemOutOfStock(id: string): Promise<void> {
  const { error } = await withSupabaseRetry(
    () => supabase.from('document_items').update({ total_cartons: 0, total_quantity: 0 }).eq('id', id),
    'markDocumentItemOutOfStock'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/compiled-products')
  revalidatePath('/products')
}

export async function updateDocumentItem(id: string, formData: FormData): Promise<void> {
  const update: Record<string, unknown> = {
    marks: ((formData.get('marks') as string) || '').trim() || null,
    item_code: ((formData.get('item_code') as string) || '').trim() || null,
    description: ((formData.get('description') as string) || '').trim() || null,
    shop: ((formData.get('shop') as string) || '').trim() || null,
    packaging: ((formData.get('packaging') as string) || '').trim() || null,
    total_cartons: intOrNull(formData.get('total_cartons')),
    total_quantity: intOrNull(formData.get('total_quantity')),
    dim_l_cm: numOrNull(formData.get('dim_l_cm')),
    dim_w_cm: numOrNull(formData.get('dim_w_cm')),
    dim_h_cm: numOrNull(formData.get('dim_h_cm')),
    unit_cbm: numOrNull(formData.get('unit_cbm')),
    total_cbm: numOrNull(formData.get('total_cbm')),
    unit_weight_kg: numOrNull(formData.get('unit_weight_kg')),
    total_weight_kg: numOrNull(formData.get('total_weight_kg')),
    unit_price_rmb: numOrNull(formData.get('unit_price_rmb')),
    total_amount_rmb: numOrNull(formData.get('total_amount_rmb')),
  }

  const { error } = await withSupabaseRetry(
    () => supabase.from('document_items').update(update).eq('id', id),
    'updateDocumentItem'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/compiled-products')
  revalidatePath('/products')
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function deleteAllProducts(options?: { sourceDocumentId?: string | null }) {
  const docId = options?.sourceDocumentId
  if (docId) {
    const { error } = await withSupabaseRetry(
      () => supabase.from('products').delete().eq('source_document_id', docId),
      'deleteAllProducts.scoped'
    )
    if (error) throw new Error(error.message)
  } else {
    const { error } = await withSupabaseRetry(
      () => supabase.from('products').delete().not('id', 'is', null),
      'deleteAllProducts'
    )
    if (error) throw new Error(error.message)
    await withSupabaseRetry(
      () => supabase.from('product_import_meta').delete().eq('id', 1),
      'deleteImportMeta'
    )
  }
  revalidatePath('/products')
  revalidatePath('/compiled-products')
  revalidatePath('/')
}

// ── Document items (canonical PDF extraction store) ───────────────────────────

export async function getDocumentItems() {
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('document_items')
        .select(DOCUMENT_ITEM_SELECT)
        .order('created_at', { ascending: false })
        .order('line_no', { ascending: true }),
    'getDocumentItems'
  )
  if (error) throw new Error(`Failed to fetch document items: ${error.message}`)
  return ((data ?? []) as unknown) as import('@/lib/types').DocumentItem[]
}

export async function getShippedDocumentItems() {
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('document_items')
        .select(DOCUMENT_ITEM_SELECT)
        .eq('section', 'shipped')
        .order('created_at', { ascending: false })
        .order('line_no', { ascending: true }),
    'getShippedDocumentItems'
  )
  if (error) throw new Error(`Failed to fetch shipped document items: ${error.message}`)
  return ((data ?? []) as unknown) as import('@/lib/types').DocumentItem[]
}

/**
 * Documents that have at least one line item (excludes empty/failed inserts).
 * Returns one row per distinct `source_file_name` (latest `created_at` wins) so the Products
 * filter is not flooded by re-imports of the same PDF. “All PDFs” still lists every line from every run.
 */
export async function getDocumentItemDocuments(): Promise<ProductDocumentRef[]> {
  const { data: joinedRows, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('documents')
        .select('id, source_file_name, document_type, extraction_status, publish_state, created_at, document_items!inner(document_id)')
        .order('created_at', { ascending: false }),
    'getDocumentItemDocuments.joined'
  )
  if (error) throw new Error(error.message)

  // Join can return duplicate document rows (one per line item). Collapse by document id first.
  const byId = new Map<string, ProductDocumentRef & { created_at: string }>()
  for (const row of joinedRows ?? []) {
    const rec = row as ProductDocumentRef & { created_at: string }
    if (rec.id && !byId.has(rec.id)) byId.set(rec.id, rec)
  }

  // Newest first, then keep one document per source file name for cleaner dropdown labels.
  const sortedNewestFirst = [...byId.values()].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  )
  const onePerFileName = new Map<string, ProductDocumentRef & { created_at: string }>()
  for (const rec of sortedNewestFirst) {
    const nameKey = (rec.source_file_name ?? '').trim().toLowerCase()
    const key = nameKey.length > 0 ? `name:${nameKey}` : `id:${rec.id}`
    if (!onePerFileName.has(key)) onePerFileName.set(key, rec)
  }
  return [...onePerFileName.values()].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  )
}

export async function deleteDocumentItem(id: string): Promise<void> {
  const { error } = await withSupabaseRetry(
    () => supabase.from('document_items').delete().eq('id', id),
    'deleteDocumentItem'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/products')
}

/** Deletes one document; line items cascade. Compiled `products` rows linked by source_document_id cascade (FK). */
export async function deleteDocumentsByDocument(documentId: string): Promise<void> {
  const { error } = await withSupabaseRetry(
    () => supabase.from('documents').delete().eq('id', documentId),
    'deleteDocumentsByDocument'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/products')
}

export async function deleteAllDocumentItems(): Promise<void> {
  const { error } = await withSupabaseRetry(
    () => supabase.from('documents').delete().not('id', 'is', null),
    'deleteAllDocumentItems'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/products')
}

/** Deletes document_items rows that match financial summary / footer patterns. */
export async function deleteDocumentFooterItems(documentId?: string | null): Promise<void> {
  const footerPatterns = [
    'TOTAL WEIGHT', 'TOTAL CBM', 'TOTAL CARTON', 'TOTAL COST', 'TOTAL BALANCE',
    'GOODS BALANCE', 'CREDIT SUPPORT', 'PIVOC', 'FREIGHT', 'EXCHANGE RATE',
    'BALANCE PAYMENT',
    'outstanding balance is not paid',
    'payment delay surcharge',
    'vessel arrival mombasa',
    'REDUCE DETAILS',
  ]
  const orFilter = footerPatterns
    .flatMap(p => [
      `marks.ilike.%${p}%`,
      `description.ilike.%${p}%`,
      `shop.ilike.%${p}%`,
    ])
    .join(',')

  let query = supabase.from('document_items').delete().or(orFilter)
  if (documentId) query = (query as any).eq('document_id', documentId)
  const { error } = await withSupabaseRetry(() => query, 'deleteDocumentFooterItems')
  if (error) throw new Error(error.message)
  revalidatePath('/products')
}

/** Deletes all document_items rows for a given section, optionally scoped to one document. */
export async function deleteDocumentItemsBySection(
  section: 'shipped' | 'left_in_warehouse' | 'repacked',
  documentId?: string | null
): Promise<void> {
  let query = supabase.from('document_items').delete().eq('section', section)
  if (documentId) query = query.eq('document_id', documentId)
  const { error } = await withSupabaseRetry(() => query, 'deleteDocumentItemsBySection')
  if (error) throw new Error(error.message)
  revalidatePath('/products')
}

// ── End document items ────────────────────────────────────────────────────────

async function saveImportMeta(meta: ImportMeta | null | undefined) {
  if (!meta) return
  const payload = {
    id: 1,
    ...meta,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('product_import_meta').upsert(payload, { onConflict: 'id' })
  if (error) {
    // Keep import resilient when product_import_meta is protected by RLS.
    logImport('saveImportMeta skipped:', error.message)
  }
}

function inferDocumentType(sourceFileName: string | null | undefined): 'sales_order' | 'container_manifest' {
  const name = (sourceFileName ?? '').toLowerCase()
  if (name.includes('销售单') || name.includes('sales') || name.includes('order')) return 'sales_order'
  return 'container_manifest'
}

function extractDocNumber(sourceFileName: string | null | undefined, clientDetails: string | null | undefined): string | null {
  const file = sourceFileName ?? ''
  const fromClient = (clientDetails ?? '').match(/\b([A-Z]{1,5}-\d{1,6})\b/i)?.[1]
  if (fromClient) return fromClient
  const fromFile = file.match(/\b([A-Z]{1,5}-\d{1,6})\b/i)?.[1]
  return fromFile ?? null
}

function extractClientId(clientDetails: string | null | undefined): string | null {
  const c = (clientDetails ?? '').trim()
  if (!c) return null
  const token = c.split(/[.\s]+/).find(Boolean)
  return token ?? null
}

function extractSalesOrderContext(rawRows: Record<string, unknown>[]): {
  orderNo: string | null
  customerNo: string | null
  deliveryAddress: string | null
  documentDate: string | null
} {
  const pick = (...keys: string[]) => {
    for (const row of rawRows) {
      for (const key of keys) {
        const value = str(row[key])
        if (value) return value
      }
    }
    return ''
  }
  return {
    orderNo: pick('ORD NO.', 'order_no') || null,
    customerNo: pick('CUS NO.', 'customer_no') || null,
    deliveryAddress: pick('送货地址', 'DELIVERY ADDRESS', 'delivery_address') || null,
    documentDate: normalizeDate(pick('DATE', 'date')),
  }
}

async function saveNormalizedDocument(payload: {
  mapped: MappedRow[]
  rawRows: Record<string, unknown>[]
  importMeta: ImportMeta | null | undefined
  aiMode: string
  modelName: string
  llmAttempts: number
  llmApplied: number
  totalsMatch: boolean
  totalsDiff: Record<string, number | null> | null
  validationFlagCounts: Record<string, number>
  validationSummary: ValidationSummary
}): Promise<{ documentId: string | null; itemIdsByLine: string[] }> {
  const sourceFileName = payload.importMeta?.source_file_name ?? null
  const documentType = payload.importMeta?.document_type ?? inferDocumentType(sourceFileName)
  const salesOrderContext = documentType === 'sales_order'
    ? extractSalesOrderContext(payload.rawRows)
    : null
  const docNumber = extractDocNumber(sourceFileName, payload.importMeta?.client_details)
  const clientDetails = payload.importMeta?.client_details ?? null
  const documentDate =
    payload.importMeta?.payment_date && /^\d{2}\/\d{2}\/\d{4}$/.test(payload.importMeta.payment_date)
      ? payload.importMeta.payment_date.split('/').reverse().join('-')
      : (salesOrderContext?.documentDate ?? null)

  const itemRows = payload.mapped
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) =>
      !((row.sku ?? '').startsWith(STAGE_SECTION_MARKER_PREFIX) ||
        (row.sku ?? '').startsWith(STAGE_TOTAL_MARKER_PREFIX) ||
        (row.sku ?? '') === REPACKAGED_SECTION_MARKER_SKU)
    )

  try {
    const { data: document, error: docErr } = await withSupabaseRetry(
      () =>
        supabase
          .from('documents')
          .insert({
            document_type: documentType,
            source_file_name: sourceFileName ?? 'unknown',
            doc_number: salesOrderContext?.orderNo ?? docNumber,
            client_id: salesOrderContext?.customerNo ?? extractClientId(clientDetails),
            client_name: clientDetails,
            document_date: documentDate,
            delivery_address: salesOrderContext?.deliveryAddress ?? null,
            container_no: payload.importMeta?.container_no ?? null,
            extraction_status: payload.validationSummary.shouldReview || !payload.totalsMatch ? 'review_needed' : 'approved',
            extraction_confidence: payload.validationSummary.qualityScore,
            parser_version: 'node-parser-v2',
            model_name: payload.modelName,
            publish_state: 'staged',
            published_at: null,
            published_by: null,
            validation_flags: payload.validationFlagCounts,
            raw_extraction: { rows_count: payload.rawRows.length, sample: payload.rawRows.slice(0, 25) },
            normalized_payload: {
              items_count: itemRows.length,
              ai_mode: payload.aiMode,
              llm_attempts: payload.llmAttempts,
              llm_applied: payload.llmApplied,
              validation_summary: payload.validationSummary,
            },
          })
          .select('id')
          .single(),
      'insertDocument'
    )
    if (docErr) {
      logImport('saveNormalizedDocument skipped (documents insert):', docErr.message)
      return { documentId: null, itemIdsByLine: [] }
    }
    if (!document?.id) return { documentId: null, itemIdsByLine: [] }

    const lines = itemRows.map(({ row, idx }) => {
      const qtyPerCarton =
        (row.cartons ?? 0) > 0 && row.quantity > 0 ? +(row.quantity / (row.cartons ?? 1)).toFixed(4) : null
      return {
        document_id: document.id,
        line_no: idx + 1,
        item_code: row.sku,
        source_item_no: row.source_item_no ?? null,
        description: row.description ?? row.name,
        shop: row.shop_name,
        packaging: row.packing,
        qty_per_carton: qtyPerCarton,
        total_cartons: row.cartons,
        total_quantity: row.quantity,
        unit_price_rmb: row.cost_price,
        total_amount_rmb: row.total_amount_rmb,
        unit_cbm: row.unit_cbm,
        total_cbm: row.cbm,
        unit_weight_kg: numOrNull(row.unit_weight),
        total_weight_kg: numOrNull(row.total_weight),
        dim_l_cm: row.dim_l_cm ?? null,
        dim_w_cm: row.dim_w_cm ?? null,
        dim_h_cm: row.dim_h_cm ?? null,
        warehouse: row.warehouse ?? null,
        barcode: row.barcode ?? null,
        remarks: row.remarks ?? null,
        code: row.code ?? null,
        photo: row.photo ?? null,
        photo2: row.photo2 ?? null,
        extraction_confidence: 85,
        validation_flags: computeValidationFlags(row, {
          requirePacking: payload.importMeta?.document_type !== 'sales_order',
        }),
      }
    })

    const itemIdsByLine: string[] = []
    if (lines.length) {
      const { data: insertedItems, error: itemErr } = await withSupabaseRetry(
        () =>
          supabase
            .from('document_items')
            .insert(lines)
            .select('id, line_no')
            .order('line_no', { ascending: true }),
        'insertDocumentItems'
      )
      if (!itemErr && insertedItems) {
        for (const it of insertedItems) itemIdsByLine[(it.line_no as number) - 1] = String(it.id)
      } else if (itemErr) {
        logImport('saveNormalizedDocument item insert skipped:', itemErr.message)
      }
    }

    await withSupabaseRetry(
      () =>
        supabase.from('document_totals').upsert({
          document_id: document.id,
          total_cartons: payload.importMeta?.total_carton ?? null,
          total_quantity: null,
          total_cbm: payload.importMeta?.total_cbm ?? null,
          total_weight_kg: payload.importMeta?.total_weight_kgs ?? null,
          total_amount_rmb: payload.importMeta?.total_cost_rmb ?? null,
          total_amount_usd: payload.importMeta?.total_cost_usd ?? null,
          computed_cartons: payload.mapped.reduce((s, p) => s + (p.cartons ?? 0), 0),
          computed_quantity: payload.mapped.reduce((s, p) => s + p.quantity, 0),
          computed_cbm: payload.mapped.reduce((s, p) => s + (p.cbm ?? 0), 0),
          computed_weight_kg: payload.mapped.reduce((s, p) => s + parseWeight(p.total_weight), 0),
          computed_amount_rmb: payload.mapped.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
          totals_match: payload.totalsMatch,
          totals_diff: payload.totalsDiff,
        }, { onConflict: 'document_id' }),
      'upsertDocumentTotals'
    )

    if (payload.importMeta?.payment_usd != null || payload.importMeta?.freight_usd != null || payload.importMeta?.credit_support_usd != null || payload.importMeta?.pivoc_usd != null) {
      const paymentRows = [
        payload.importMeta?.payment_usd != null
          ? {
              document_id: document.id,
              payment_date: documentDate,
              amount_usd: payload.importMeta.payment_usd,
              payment_type: 'deposit',
              note: 'Imported payment',
            }
          : null,
        payload.importMeta?.freight_usd != null
          ? { document_id: document.id, amount_usd: payload.importMeta.freight_usd, payment_type: 'freight', note: 'Imported freight' }
          : null,
        payload.importMeta?.credit_support_usd != null
          ? { document_id: document.id, amount_usd: payload.importMeta.credit_support_usd, payment_type: 'credit', note: 'Credit support' }
          : null,
        payload.importMeta?.pivoc_usd != null
          ? { document_id: document.id, amount_usd: payload.importMeta.pivoc_usd, payment_type: 'other', note: 'PIVOC' }
          : null,
      ].filter(Boolean)
      if (paymentRows.length) {
        await withSupabaseRetry(
          () => supabase.from('document_payments').insert(paymentRows as any[]),
          'insertDocumentPayments'
        )
      }
    }

    await withSupabaseRetry(
      () =>
        supabase.from('extraction_runs').insert({
          document_id: document.id,
          run_no: 1,
          ai_mode: payload.aiMode,
          model_name: payload.modelName,
          prompt_version: 'v1',
          status: 'completed',
          llm_attempts: payload.llmAttempts,
          llm_applied: payload.llmApplied,
          metrics: {
            totals_match: payload.totalsMatch,
            validation_flag_counts: payload.validationFlagCounts,
            validation_summary: payload.validationSummary,
          },
        }),
      'insertExtractionRun'
    )

    return { documentId: document.id as string, itemIdsByLine }
  } catch (err: any) {
    logImport('saveNormalizedDocument exception:', err?.message ?? err)
    return { documentId: null, itemIdsByLine: [] }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pickEnglishFirst(a: string, b: string): string | null {
  const aLatin = /^[A-Za-z]/.test(a)
  const bLatin = /^[A-Za-z]/.test(b)
  if (aLatin) return a        // descGoods is English → use it
  if (bLatin) return b        // col6val is English → use it
  return a || b || null       // both Chinese or empty → take whatever exists
}

function str(v: unknown): string {
  return String(v ?? '').trim()
}

function normalizeDate(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split('/').reverse().join('-')
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split('-')
    return `${y}-${m}-${d}`
  }
  return null
}

function num(v: unknown): number {
  return parseFloat(str(v).replace(/[^\d.-]/g, '')) || 0
}

function numOrNull(v: unknown): number | null {
  const n = parseFloat(str(v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? null : n
}

function intOrNull(v: unknown): number | null {
  const s = str(v).replace(/[^\d]/g, '')
  return s ? parseInt(s) : null
}

function parseUnit(packing: string): string {
  const m = packing.match(/\d+\s*([a-zA-Z]+)\s*\/\s*ctn/i)
  return m ? m[1].toLowerCase() : 'pcs'
}

function parseWeight(w: string | null | undefined): number {
  return parseFloat((w ?? '0').replace(/[^\d.]/g, '')) || 0
}

function firstNumeric(
  row: Record<string, unknown>,
  keys: string[],
  parser: (value: unknown) => number | null
): number | null {
  for (const key of keys) {
    if (!(key in row)) continue
    const parsed = parser(row[key])
    if (parsed != null) return parsed
  }
  return null
}

function parsePackingCartons(packing: string | null | undefined): number | null {
  const s = str(packing)
  const m = s.match(/^(\d+(?:\.\d+)?)\s*CTNS?$/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

function parseTrailingPackingFromDescription(description: string | null | undefined): { description: string | null; packing: string | null; qtyPerCarton: number | null } {
  const s = str(description)
  const m = s.match(/^(.*?)(\d+(?:\.\d+)?\s*pcs\/ctn)\s*$/i)
  if (!m) return { description: s || null, packing: null, qtyPerCarton: null }
  const qty = Number((m[2].match(/(\d+(?:\.\d+)?)/)?.[1] ?? ''))
  return {
    description: str(m[1]) || null,
    packing: m[2],
    qtyPerCarton: Number.isFinite(qty) ? qty : null,
  }
}

function repairShiftedPackingListRow(row: MappedRow): MappedRow {
  const packing = str(row.packing)
  const hasCartonPacking = /^(\d+(?:\.\d+)?)\s*CTNS?$/i.test(packing)
  const hasTrailingPcs = /\d+(?:\.\d+)?\s*pcs\/ctn\s*$/i.test(str(row.description))
  const cartons = row.cartons ?? 0
  const qty = row.quantity ?? 0
  const dimL = row.dim_l_cm ?? 0
  const unitPrice = row.cost_price ?? 0
  const amount = row.total_amount_rmb ?? 0
  const totalCbm = row.cbm ?? 0

  const looksLikeClassicShift =
    hasCartonPacking &&
    hasTrailingPcs &&
    cartons > 0 &&
    qty > 0 &&
    (cartons >= 100 || cartons > qty * 2) &&
    qty >= 20 &&
    qty <= 200 &&
    dimL > 0 &&
    dimL < 2 &&
    unitPrice >= 500 &&
    amount >= 0 &&
    amount < 1000

  const looksLikePartsShift =
    hasCartonPacking &&
    hasTrailingPcs &&
    cartons > 0 &&
    qty > 0 &&
    (totalCbm >= 5 || (row.unit_weight != null && parseWeight(row.unit_weight) >= 200)) &&
    amount > 0 &&
    amount < 1000

  if (!looksLikeClassicShift && !looksLikePartsShift) return row

  const extracted = parseTrailingPackingFromDescription(row.description)
  const fixedCartons = parsePackingCartons(row.packing) ?? row.cartons
  const oldCost = row.cost_price
  const oldAmount = row.total_amount_rmb

  const repaired: MappedRow = {
    ...row,
    description: extracted.description,
    packing: extracted.packing ?? row.packing,
    cartons: fixedCartons,
    quantity: row.cartons ?? row.quantity,
    dim_h_cm: row.quantity,
    dim_w_cm: row.dim_h_cm ?? null,
    dim_l_cm: row.dim_w_cm ?? null,
    unit_cbm: row.dim_l_cm ?? null,
    cbm: row.unit_cbm ?? null,
    unit_weight: row.cbm != null ? `${row.cbm}KGS` : null,
    total_weight: row.unit_weight ?? null,
    cost_price: (numOrNull(row.total_weight) ?? 0),
    total_amount_rmb: oldCost ?? null,
    remarks: row.remarks ? `${row.remarks};repair:shifted_manifest_columns` : 'repair:shifted_manifest_columns',
  }

  // Rows like "Food warmer parts ..." have no price/amount in the PDF.
  if ((row.sku == null || row.sku === '') && /FOOD\s+WARMER\s+PARTS/i.test(str(row.description))) {
    repaired.cost_price = 0
    repaired.total_amount_rmb = null
  } else if ((numOrNull(row.total_weight) ?? 0) <= 0 && (oldAmount ?? 0) > 0 && (oldAmount ?? 0) < 1000) {
    repaired.total_amount_rmb = null
  }

  return repaired
}

function repairNoPackingAmountRow(row: MappedRow): MappedRow {
  const isNoPacking = !str(row.packing)
  const hasQtyInCartons = (row.cartons ?? 0) > 0 && row.quantity <= 0
  const priceStoredInWeight = (numOrNull(row.total_weight) ?? 0) >= 50 && (numOrNull(row.total_weight) ?? 0) <= 1000
  const amountStoredInCost = row.cost_price >= 1000
  const amountLooksLikeBoxNo = (row.total_amount_rmb ?? 0) >= 100 && (row.total_amount_rmb ?? 0) <= 500
  if (!isNoPacking || !hasQtyInCartons || !priceStoredInWeight || !amountStoredInCost || !amountLooksLikeBoxNo) return row

  return {
    ...row,
    cartons: null,
    quantity: row.cartons ?? 0,
    cost_price: numOrNull(row.total_weight) ?? 0,
    total_amount_rmb: row.cost_price > 0 ? row.cost_price : null,
    total_weight: row.total_weight,
    remarks: row.remarks ? `${row.remarks};repair:no_packing_amount_row` : 'repair:no_packing_amount_row',
  }
}

function repairSalesOrderRow(row: MappedRow): MappedRow {
  let next: MappedRow = { ...row }
  const cartons = next.cartons ?? 0
  const qty = next.quantity ?? 0
  const amount = next.total_amount_rmb ?? 0
  const packing = str(next.packing)

  if (packing && !/\d/.test(packing) && cartons > 0 && qty > 0) {
    const inferredPpc = qty / cartons
    const rounded = Math.round(inferredPpc)
    if (Number.isFinite(inferredPpc) && rounded > 0 && Math.abs(inferredPpc - rounded) <= 0.02) {
      next.packing = `${rounded}pcs/ctn`
      next.unit = 'pcs'
      next.remarks = next.remarks ? `${next.remarks};repair:packing_from_qty_cartons` : 'repair:packing_from_qty_cartons'
    } else {
      next.packing = null
      next.remarks = next.remarks ? `${next.remarks};repair:drop_non_numeric_packing` : 'repair:drop_non_numeric_packing'
    }
  }

  if ((next.cost_price ?? 0) <= 0 && amount > 0 && qty > 0) {
    const inferred = Math.round((amount / qty) * 10000) / 10000
    if (inferred > 0) {
      next.cost_price = inferred
      next.remarks = next.remarks ? `${next.remarks};repair:price_from_amount` : 'repair:price_from_amount'
    }
  }

  if ((next.total_amount_rmb ?? 0) <= 0 && qty > 0 && (next.cost_price ?? 0) > 0) {
    next.total_amount_rmb = Math.round(qty * (next.cost_price ?? 0) * 100) / 100
    next.remarks = next.remarks ? `${next.remarks};repair:amount_from_qty_price` : 'repair:amount_from_qty_price'
  }

  return next
}

/** True if col 0 of a data row looks like a valid product MARKS value */
function isValidMarks(raw: string): boolean {
  const first = raw.split('\n')[0].trim()
  if (!first) return false
  if (first.length < 3) return false
  if (/\s/.test(first)) return false
  if (/[¥￥]/.test(first)) return false
  if (/\\/.test(first)) return false
  const upper = first.toUpperCase()
  return !(
    upper.includes('MARKS') ||
    upper.includes('PACKING') ||
    upper.includes('ITEM') ||
    upper.includes('SHOP') ||
    upper.includes('CLIENT DETAILS') ||
    upper.includes('CONTAINER NO') ||
    upper.includes('NEW ORDER') ||
    upper.includes('GOODS LEFT') ||
    upper.includes('GOODS BALANCE') ||
    upper.includes('TOTAL ') ||
    upper.includes('PCS') ||
    upper.includes('CTN') ||
    upper.includes('CBM') ||
    upper.includes('KGS')
  )
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importProducts(rows: Record<string, unknown>[], importMeta?: ImportMeta | null) {
  const allKeys = new Set(rows.flatMap(r => Object.keys(r)))
  const requestedDocType = importMeta?.document_type ?? null
  const isSalesOrderDoc = requestedDocType === 'sales_order'
  const hasPackingListKeys =
    allKeys.has('MARKS') || allKeys.has('T.QTY') || allKeys.has('U.PRICE (RMB)')
  const isPackingList = !isSalesOrderDoc && hasPackingListKeys

  logImport(
    'importProducts: incoming rows=',
    rows.length,
    'isPackingList=',
    isPackingList,
    'isSalesOrderDoc=',
    isSalesOrderDoc
  )
  logImport(
    'column keys (sample):',
    [...allKeys].filter(k => !k.startsWith('__col')).slice(0, 24),
    'has __col*',
    [...allKeys].some(k => k.startsWith('__col'))
  )
  if (rows[0]) {
    logImport('first raw row keys:', Object.keys(rows[0]), 'MARKS=', String(rows[0].MARKS ?? '').slice(0, 40))
  }

  let retainedInvalidMarks = 0
  let llmAttempts = 0
  let llmApplied = 0
  const aiMode = (process.env.AI_IMPORT_MODE ?? 'hybrid').toLowerCase() // hybrid | full
  const invalidMarksSamples: string[] = []
  const zeroOrBad: {
    sku: string | null
    quantity: number
    cost_price: number
    isShifted: boolean
    raw: Record<string, unknown>
  }[] = []

  const mapped: MappedRow[] = []
  const llmCandidates: LlmCandidate[] = []

  for (const r of rows) {
    if (isPackingList) {
      const rawSku = str(r['MARKS'] ?? '')

      // Preserve section headers from packing list so UI can render dividers.
      // If the section marker text is malformed, treat it like a normal row
      // instead of dropping it.
      if (rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX) || rawSku.startsWith(STAGE_TOTAL_MARKER_PREFIX)) {
        const title = rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX)
          ? rawSku.slice(STAGE_SECTION_MARKER_PREFIX.length)
          : rawSku.slice(STAGE_TOTAL_MARKER_PREFIX.length)
        const malformedSectionMarker =
          rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX) && !isValidStageSectionTitle(title)
        if (!malformedSectionMarker) {
          mapped.push({
            sku: rawSku,
            name: title,
            description: null,
            shop_name: null,
            unit: 'pcs',
            packing: null,
            cartons: 0,
            quantity: 0,
            unit_cbm: null,
            cbm: null,
            unit_weight: null,
            total_weight: null,
            cost_price: 0,
            total_amount_rmb: null,
            selling_price: 0,
            reorder_level: 0,
          })
          continue
        }
        logImport('malformed stage marker kept as data row:', title.slice(0, 160))
      }

      if (isGoodsLeftHeader(rawSku)) {
        continue
      }

      if (isRepackagedSectionHeader(rawSku)) {
        // Repacked-goods section marker — stop importing here.
        logImport('importProducts: hit repacked section boundary, stopping row processing')
        break
      }

      // Keep all rows (except explicit goods-left / repackaged boundary rules).
      // Invalid MARKS are retained and still mapped.
      if (!isValidMarks(rawSku)) {
        // Retained for diagnostics only. We no longer drop these rows.
        retainedInvalidMarks++
        if (invalidMarksSamples.length < 10)
          invalidMarksSamples.push(String(rawSku).replace(/\n/g, '\\n').slice(0, 120))
      }

      const sku = rawSku.split('\n')[0].trim() || null

      const descGoods = str(r['DESCRIPTION OF GOODS'] ?? '')
      const col6val = str(r['__col6'] ?? '')
      const shop = str(r['SHOP#'] ?? '') || null

      // CSV conversion sometimes shifts columns when a cell is merged.
      // Detection: a valid PACKING value contains a slash (e.g. "15pcs/ctn").
      // If PACKING has no slash, the Chinese product name ended up there and
      // the real packing/qty/cbm/price columns are each shifted one to the right.
      const packingField = str(r['PACKING'] ?? '')
      const packingLooksStandard = /\d+\s*[a-zA-Z]+\s*\/\s*ctn/i.test(packingField)
      const packingLooksCartonCount = /^\d+(?:\.\d+)?\s*CTNS?$/i.test(packingField)
      const packingLooksLikeName =
        /[A-Za-z\u4E00-\u9FFF]/.test(packingField) && !/\d+(?:\.\d+)?\s*CTNS?/i.test(packingField)
      // Shifted only when "PACKING" clearly contains name-like text, not carton counts like "10CTNS".
      const isShifted =
        !!packingField && !packingLooksStandard && !packingLooksCartonCount && packingLooksLikeName

      let name: string | null
      let packing: string | null
      let cartons: number | null
      let quantity: number
      let unit_cbm: number | null
      let cbm: number | null
      let unit_weight: string | null
      let total_weight: string | null
      let cost_price: number
      let total_amount_rmb: number | null

      if (isShifted) {
        // packingField actually contains the Chinese product name; real data shifts right
        name = packingField || col6val || descGoods || null
        packing = str(r['T.CTN'] ?? '') || null
        cartons = intOrNull(r['T.QTY'])
        quantity = intOrNull(r['T.CBM']) ?? 0
        unit_cbm = numOrNull(r['UNIT CBM'])
        cbm = numOrNull(r['UNIT WEIGHT'])
        unit_weight = str(r['T.WEIGHT'] ?? '') || null
        total_weight = str(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? '') || null
        cost_price = num(r['T.AMOUNT'])
        total_amount_rmb = numOrNull(r['__col15'] ?? r['__col14'] ?? '')
      } else {
        // Prefer whichever value starts with a Latin letter (English name over
        // Chinese-only text). If both or neither are Latin, descGoods wins.
        name = pickEnglishFirst(descGoods, col6val)
        packing = packingField || null
        cartons = intOrNull(r['T.CTN'])
        quantity = intOrNull(r['T.QTY']) ?? 0
        unit_cbm = numOrNull(r['UNIT CBM'])
        cbm = numOrNull(r['T.CBM'])
        unit_weight = str(r['UNIT WEIGHT'] ?? '') || null
        total_weight = str(r['T.WEIGHT'] ?? '') || null
        cost_price = num(
          r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? r['unit_price_rmb'] ?? ''
        )
        total_amount_rmb = numOrNull(r['T.AMOUNT'])
        if (
          (!(cost_price > 0)) &&
          total_amount_rmb != null &&
          total_amount_rmb > 0 &&
          quantity > 0
        ) {
          const inferred = Math.round((total_amount_rmb / quantity) * 100) / 100
          if (inferred > 0) cost_price = inferred
        }
      }

      let mappedRow: MappedRow = {
        sku,
        name,
        description: [descGoods, col6val].filter(Boolean).join(' – ') || null,
        shop_name: shop,
        unit: packing ? parseUnit(packing) : 'pcs',
        packing,
        cartons,
        quantity,
        unit_cbm,
        cbm,
        unit_weight,
        total_weight,
        cost_price,
        total_amount_rmb,
        selling_price: 0,
        reorder_level: 0,
      }
      mappedRow = repairShiftedPackingListRow(mappedRow)
      mappedRow = repairNoPackingAmountRow(mappedRow)

      const fromClaudeCore = str(r['__source']) === 'claude_core'
      const shouldUseLlm = !fromClaudeCore && (aiMode === 'full' || shouldUseLlmAlignment(r, mappedRow))
      mapped.push(mappedRow)
      if (shouldUseLlm) {
        llmCandidates.push({ mappedIndex: mapped.length - 1, raw: r, sku })
      }

      if (mappedRow.quantity === 0 || mappedRow.cost_price === 0) {
        if (zeroOrBad.length < 25)
          zeroOrBad.push({
            sku,
            quantity: mappedRow.quantity,
            cost_price: mappedRow.cost_price,
            isShifted,
            raw: {
              PACKING: r['PACKING'],
              'T.CTN': r['T.CTN'],
              'T.QTY': r['T.QTY'],
              'T.CBM': r['T.CBM'],
              'U.PRICE (RMB)': r['U.PRICE (RMB)'],
              'T.AMOUNT': r['T.AMOUNT'],
            },
          })
      }
    } else if (isSalesOrderDoc) {
      // Sales order mapper: same row-level keys may still come through MARKS/T.QTY style
      // after OCR/LLM extraction, so do not force exported-file schema here.
      const sku = str(r['MARKS'] ?? r['item_code'] ?? r['SKU'] ?? r['sku']) || null
      const sourceItemNo = str(r['ITEM NO.'] ?? r['item_no'] ?? r['NO.'] ?? '') || null
      const name = str(r['DESCRIPTION OF GOODS'] ?? r['description'] ?? r['name'] ?? r['Name']) || null
      const packingFromText =
        str(r['PACKING'] ?? '') ||
        ((name ?? '').match(/\b\d+\s*(?:pcs|set|sets|dec)\s*\/\s*(?:ctn|box)\b/i)?.[0] ?? '') ||
        null
      const documentDateRaw = str(r['DATE'] ?? r['date'] ?? '')
      const documentDate = normalizeDate(documentDateRaw)
      const costPrice =
        firstNumeric(
          r,
          [
            'U.PRICE (RMB)',
            'U.PRICE(RMB)',
            'U.PRICE',
            'U/P',
            'UNIT PRICE',
            'UNIT_PRICE',
            'PRICE',
            'unit_price_rmb',
            'cost_price',
            '__col14',
            '__col13',
          ],
          numOrNull
        ) ?? 0
      const totalAmount = firstNumeric(
        r,
        ['T.AMOUNT', 'T.AMOUNT(RMB)', 'AMOUNT', 'total_amount_rmb', '__col15', '__col16', '__col14'],
        numOrNull
      )

      let salesMapped: MappedRow = {
        sku,
        source_item_no: sourceItemNo,
        name,
        description: name,
        shop_name: str(r['SHOP#'] ?? r['shop'] ?? '') || null,
        unit: packingFromText ? parseUnit(packingFromText) : 'pcs',
        packing: packingFromText,
        cartons: intOrNull(r['T.CTN'] ?? r['CTN'] ?? r['total_cartons']),
        quantity: intOrNull(r['T.QTY'] ?? r['QTY'] ?? r['total_qty'] ?? r['quantity']) ?? 0,
        unit_cbm: numOrNull(r['UNIT CBM'] ?? r['unit_cbm']),
        cbm: numOrNull(r['T.CBM'] ?? r['CBM'] ?? r['total_cbm']),
        unit_weight: str(r['UNIT WEIGHT'] ?? r['unit_weight'] ?? '') || null,
        total_weight: str(r['T.WEIGHT'] ?? r['total_weight'] ?? '') || null,
        dim_l_cm: numOrNull(r['L'] ?? r['l'] ?? r['dim_l_cm']),
        dim_w_cm: numOrNull(r['W'] ?? r['w'] ?? r['dim_w_cm']),
        dim_h_cm: numOrNull(r['H'] ?? r['h'] ?? r['dim_h_cm']),
        cost_price: costPrice,
        total_amount_rmb: totalAmount,
        warehouse: str(r['W.H.'] ?? r['warehouse'] ?? '') || null,
        remarks: str(r['REK'] ?? r['remarks'] ?? '') || null,
        barcode: str(r['CODE'] ?? r['barcode'] ?? '') || null,
        code: str(r['CODE'] ?? r['code'] ?? '') || null,
        photo: str(r['PHOTO'] ?? r['photo'] ?? '') || null,
        photo2: str(r['PHOTO2'] ?? r['photo2'] ?? '') || null,
        order_no: str(r['ORD NO.'] ?? r['order_no'] ?? '') || null,
        customer_no: str(r['CUS NO.'] ?? r['customer_no'] ?? '') || null,
        delivery_address: str(r['送货地址'] ?? r['delivery_address'] ?? '') || null,
        document_date: documentDate,
        selling_price: num(r['selling_price'] ?? r['Selling Price']),
        reorder_level: intOrNull(r['reorder_level'] ?? r['Reorder Level']) ?? 0,
      }
      salesMapped = repairSalesOrderRow(salesMapped)
      mapped.push(salesMapped)
    } else {
      // Standard exported format (column names from our own Excel export)
      const name = str(r['name'] ?? r['Name']) || null
      const sku = str(r['sku'] ?? r['SKU']) || null
      if (!name && !sku) continue
      mapped.push({
        sku,
        name,
        description: str(r['description'] ?? r['Description']) || null,
        shop_name: null,
        unit: str(r['unit'] ?? r['Unit']) || 'pcs',
        packing: null,
        cartons: null,
        quantity: intOrNull(r['quantity'] ?? r['Quantity']) ?? 0,
        unit_cbm: numOrNull(r['unit_cbm'] ?? r['Unit CBM']),
        cbm: null,
        unit_weight: null,
        total_weight: null,
        cost_price: num(r['cost_price'] ?? r['Cost Price']),
        total_amount_rmb: null,
        selling_price: num(r['selling_price'] ?? r['Selling Price']),
        reorder_level: intOrNull(r['reorder_level'] ?? r['Reorder Level']) ?? 0,
      })
    }
  }

  if (llmCandidates.length > 0) {
    const llmBatchSize = Math.max(1, Number(process.env.LLM_BATCH_SIZE ?? 20))
    const llmBatchPauseMs = Math.max(0, Number(process.env.LLM_BATCH_PAUSE_MS ?? 0))
    logImport('LLM batching config:', { candidates: llmCandidates.length, llmBatchSize, llmBatchPauseMs })

    for (let i = 0; i < llmCandidates.length; i += llmBatchSize) {
      const batch = llmCandidates.slice(i, i + llmBatchSize)
      llmAttempts += batch.length
      await Promise.all(
        batch.map(async candidate => {
          const mappedRow = mapped[candidate.mappedIndex]
          logImport('LLM considered for row:', {
            sku: candidate.sku,
            currentPacking: mappedRow.packing,
            currentQty: mappedRow.quantity,
            currentCost: mappedRow.cost_price,
          })
          const ai = await alignPackingRowWithLlm(candidate.raw)
          if (!ai) {
            // All providers failed or are cooling down — keep the regex-parsed values as-is
            logImport('LLM unavailable, keeping parser result for:', { sku: candidate.sku })
            return
          }

          const aiPacking = ai.packing ?? mappedRow.packing
          const aiQuantity = ai.quantity ?? mappedRow.quantity
          const aiCostPrice = ai.cost_price ?? mappedRow.cost_price
          const aiName = sanitizeAlignedText(ai.name) ?? mappedRow.name
          const aiShop = sanitizeAlignedText(ai.shop_name) ?? mappedRow.shop_name
          const improved = hasMeaningfulLlmImprovement(
            {
              packing: mappedRow.packing,
              quantity: mappedRow.quantity,
              cost_price: mappedRow.cost_price,
              name: mappedRow.name,
              shop_name: mappedRow.shop_name,
            },
            {
              packing: aiPacking,
              quantity: aiQuantity,
              cost_price: aiCostPrice,
              name: aiName,
              shop_name: aiShop,
            }
          )
          if (!improved) {
            logImport('LLM response ignored (no improvement):', { sku: candidate.sku, ai })
            return
          }

          llmApplied++
          const nextRow: MappedRow = {
            ...mappedRow,
            name: aiName,
            description: ai.description ?? mappedRow.description,
            shop_name: aiShop,
            packing: aiPacking,
            cartons: ai.cartons ?? mappedRow.cartons,
            quantity: aiQuantity,
            unit_cbm: ai.unit_cbm ?? mappedRow.unit_cbm,
            cbm: ai.cbm ?? mappedRow.cbm,
            unit_weight: ai.unit_weight ?? mappedRow.unit_weight,
            total_weight: ai.total_weight ?? mappedRow.total_weight,
            cost_price: aiCostPrice,
            total_amount_rmb: ai.total_amount_rmb ?? mappedRow.total_amount_rmb,
            unit: aiPacking ? parseUnit(aiPacking) : mappedRow.unit,
          }
          mapped[candidate.mappedIndex] = nextRow
          logImport('LLM applied for row:', {
            sku: candidate.sku,
            packing: nextRow.packing,
            quantity: nextRow.quantity,
            cost_price: nextRow.cost_price,
          })
        })
      )
      if (i + llmBatchSize < llmCandidates.length && llmBatchPauseMs > 0) {
        await sleep(llmBatchPauseMs)
      }
    }
  }

  logImport(
    'mapped rows:',
    mapped.length,
    'llm attempts/applied:',
    `${llmAttempts}/${llmApplied}`,
    'retained (invalid MARKS):',
    retainedInvalidMarks,
    invalidMarksSamples.length ? 'samples:' : '',
    invalidMarksSamples
  )
  if (zeroOrBad.length)
    logImport(
      'rows with quantity=0 OR cost_price=0 (first 25):',
      zeroOrBad.length,
      zeroOrBad
    )
  if (isPackingList && mapped.length && importDebug()) {
    const s = mapped[0]
    logImport('first mapped product:', {
      sku: s.sku,
      quantity: s.quantity,
      cost_price: s.cost_price,
      packing: s.packing,
      cartons: s.cartons,
    })
  }

  if (mapped.length === 0) throw new Error('No valid product rows found in file')
  const dataMappedCount = mapped.filter(
    m =>
      !(m.sku ?? '').startsWith(STAGE_SECTION_MARKER_PREFIX) &&
      !(m.sku ?? '').startsWith(STAGE_TOTAL_MARKER_PREFIX) &&
      (m.sku ?? '') !== REPACKAGED_SECTION_MARKER_SKU
  ).length
  if (dataMappedCount === 0) {
    throw new Error('Import produced section markers only (no product rows). Please re-import and check parser logs.')
  }

  const validationFlagCounts: Record<string, number> = {}
  const validationSamples: Array<{
    sku: string | null
    quantity: number
    cartons: number | null
    packing: string | null
    cost_price: number
    total_amount_rmb: number | null
    flags: ImportValidationFlag[]
  }> = []
  for (const row of mapped) {
    const isMarker =
      (row.sku ?? '').startsWith(STAGE_SECTION_MARKER_PREFIX) ||
      (row.sku ?? '').startsWith(STAGE_TOTAL_MARKER_PREFIX) ||
      (row.sku ?? '') === REPACKAGED_SECTION_MARKER_SKU
    if (isMarker) continue
    const flags = computeValidationFlags(row, { requirePacking: !isSalesOrderDoc })
    if (!flags.length) continue
    for (const f of flags) validationFlagCounts[f] = (validationFlagCounts[f] ?? 0) + 1
    if (validationSamples.length < 20) {
      validationSamples.push({
        sku: row.sku,
        quantity: row.quantity,
        cartons: row.cartons,
        packing: row.packing,
        cost_price: row.cost_price,
        total_amount_rmb: row.total_amount_rmb,
        flags,
      })
    }
  }
  if (Object.keys(validationFlagCounts).length > 0) {
    logImport('validation flag counts:', validationFlagCounts)
    logImport('validation samples (first 20):', validationSamples)
  }
  const validationSummary = summarizeValidation(mapped, { requirePacking: !isSalesOrderDoc })
  logImport('validation summary:', validationSummary)

  const computedTotals = {
    cartons: mapped.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: mapped.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: mapped.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amountRmb: mapped.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }

  const totalsDiff = importMeta
    ? {
        cartons: importMeta.total_carton != null ? +(computedTotals.cartons - importMeta.total_carton).toFixed(2) : null,
        cbm: importMeta.total_cbm != null ? +(computedTotals.cbm - importMeta.total_cbm).toFixed(4) : null,
        weight: importMeta.total_weight_kgs != null ? +(computedTotals.weight - importMeta.total_weight_kgs).toFixed(2) : null,
        amountRmb: importMeta.total_cost_rmb != null ? +(computedTotals.amountRmb - importMeta.total_cost_rmb).toFixed(2) : null,
      }
    : null

  const hasPdfTotals = !!importMeta && (
    importMeta.total_carton != null ||
    importMeta.total_cbm != null ||
    importMeta.total_weight_kgs != null ||
    importMeta.total_cost_rmb != null
  )
  const totalsMatch = hasPdfTotals && !!totalsDiff && (
    Math.abs(totalsDiff.cartons ?? 0) <= 0.5 &&
    Math.abs(totalsDiff.cbm ?? 0) <= 0.05 &&
    Math.abs(totalsDiff.weight ?? 0) <= 1 &&
    Math.abs(totalsDiff.amountRmb ?? 0) <= 5
  )

  logImport('totals reconciliation:', {
    aiMode,
    computedTotals,
    pdfTotals: importMeta
      ? {
          cartons: importMeta.total_carton,
          cbm: importMeta.total_cbm,
          weight: importMeta.total_weight_kgs,
          amountRmb: importMeta.total_cost_rmb,
        }
      : null,
    totalsDiff,
    totalsMatch,
  })

  const modelName = process.env.LLM_MODEL || process.env.GROQ_MODEL || 'deepseek/deepseek-chat-v3-0324'
  const normalizedDoc = await saveNormalizedDocument({
    mapped,
    rawRows: rows,
    importMeta,
    aiMode,
    modelName,
    llmAttempts,
    llmApplied,
    totalsMatch,
    totalsDiff,
    validationFlagCounts,
    validationSummary,
  })

  const insertedDocumentItemCount = normalizedDoc.itemIdsByLine.filter(Boolean).length
  const rowParityMatch = insertedDocumentItemCount === dataMappedCount
  const strictValidationGate = (process.env.IMPORT_STRICT_VALIDATION_GATE ?? '1') !== '0'
  const hasRequiredPdfTotalsForGate = !!importMeta && (
    importMeta.total_carton != null &&
    importMeta.total_cbm != null &&
    importMeta.total_weight_kgs != null &&
    importMeta.total_cost_rmb != null
  )
  const gatePass = rowParityMatch && hasRequiredPdfTotalsForGate && totalsMatch

  logImport('strict gate check:', {
    strictValidationGate,
    rowParityMatch,
    insertedDocumentItemCount,
    dataMappedCount,
    hasRequiredPdfTotalsForGate,
    totalsMatch,
    gatePass,
  })

  if (strictValidationGate && !gatePass) {
    const reasons: string[] = []
    if (!rowParityMatch) reasons.push(`row parity failed (pdf_rows=${dataMappedCount}, staged_rows=${insertedDocumentItemCount})`)
    if (!hasRequiredPdfTotalsForGate) reasons.push('missing required PDF footer totals for strict match')
    if (!totalsMatch) reasons.push('totals mismatch')
    logImport(
      `Import gate failed but continuing (document staged): ${reasons.join('; ')}.`
    )
  }

  if (!normalizedDoc.documentId) {
    // Legacy fallback path only when normalized staging fails unexpectedly.
    const CHUNK = 50
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const chunk = mapped.slice(i, i + CHUNK).map((row, localIdx) => {
        const lineNo = i + localIdx + 1
        const maybeItemId = normalizedDoc.itemIdsByLine[lineNo - 1] ?? null
        return {
          ...row,
          source_document_id: normalizedDoc.documentId,
          source_document_item_id: maybeItemId,
          extraction_confidence: validationSummary.qualityScore,
          extraction_flags: computeValidationFlags(row, { requirePacking: !isSalesOrderDoc }),
        }
      })
      const { error } = await withSupabaseRetry(
        () => supabase.from('products').insert(chunk),
        `importProducts chunk ${Math.floor(i / CHUNK) + 1}`
      )
      if (error) throw new Error(error.message)
    }
  }

  await saveImportMeta(importMeta)
  await saveExtractionAudit({
    import_meta: importMeta,
    ai_mode: aiMode,
    llm_attempts: llmAttempts,
    llm_aligned: llmApplied,
    totals_match: totalsMatch,
    totals_diff: totalsDiff,
    validation_flag_counts: validationFlagCounts,
    sample_rows: validationSamples,
  })

  revalidatePath('/products')
  revalidatePath('/')
  return {
    importedCount: normalizedDoc.documentId ? 0 : mapped.length,
    stagedCount: mapped.length,
    stagedOnly: !!normalizedDoc.documentId,
    documentId: normalizedDoc.documentId,
    llmAttempts,
    llmAligned: llmApplied,
    aiMode,
    totalsMatch,
    totalsDiff,
  }
}

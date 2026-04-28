'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'
import type { ImportMeta } from '@/lib/types'
import { REPACKAGED_SECTION_MARKER_SKU, REPACKAGED_SECTION_TITLE, STAGE_SECTION_MARKER_PREFIX, STAGE_TOTAL_MARKER_PREFIX, isRepackagedSectionHeader, isGoodsLeftHeader, isValidStageSectionTitle } from '@/lib/sections'
import Anthropic from '@anthropic-ai/sdk'

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
  cost_price: number
  total_amount_rmb: number | null
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

function computeValidationFlags(row: MappedRow): ImportValidationFlag[] {
  const flags: ImportValidationFlag[] = []
  const cartons = row.cartons ?? 0
  const qty = row.quantity
  const price = row.cost_price
  const amount = row.total_amount_rmb ?? 0
  if (!row.name) flags.push('missing_name')
  if (!row.packing) flags.push('missing_packing')
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

function summarizeValidation(mapped: MappedRow[]): ValidationSummary {
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
    const flags = computeValidationFlags(row)
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
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('products')
        .select('*, categories(id,name), suppliers(id,name)')
        .order('created_at', { ascending: true }),
    'getProducts'
  )
  if (error) throw new Error(error.message)
  return data
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

export async function getReviewDocuments() {
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('documents')
        .select('id, document_type, source_file_name, client_name, container_no, extraction_status, extraction_confidence, validation_flags, created_at')
        .in('extraction_status', ['review_needed', 'failed'])
        .order('created_at', { ascending: false })
        .limit(200),
    'getReviewDocuments'
  )
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function approveDocumentReview(id: string) {
  const { error } = await withSupabaseRetry(
    () =>
      supabase
        .from('documents')
        .update({ extraction_status: 'approved', extraction_confidence: 95 })
        .eq('id', id),
    'approveDocumentReview'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/review-queue')
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
    category_id: (formData.get('category_id') as string) || null,
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
    category_id: (formData.get('category_id') as string) || null,
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

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function deleteAllProducts() {
  const { error } = await withSupabaseRetry(
    () => supabase.from('products').delete().not('id', 'is', null),
    'deleteAllProducts'
  )
  if (error) throw new Error(error.message)
  await withSupabaseRetry(
    () => supabase.from('product_import_meta').delete().eq('id', 1),
    'deleteImportMeta'
  )
  revalidatePath('/products')
  revalidatePath('/compiled-products')
  revalidatePath('/')
}

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
  const docNumber = extractDocNumber(sourceFileName, payload.importMeta?.client_details)
  const clientDetails = payload.importMeta?.client_details ?? null
  const documentDate =
    payload.importMeta?.payment_date && /^\d{2}\/\d{2}\/\d{4}$/.test(payload.importMeta.payment_date)
      ? payload.importMeta.payment_date.split('/').reverse().join('-')
      : null

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
            doc_number: docNumber,
            client_id: extractClientId(clientDetails),
            client_name: clientDetails,
            document_date: documentDate,
            container_no: payload.importMeta?.container_no ?? null,
            extraction_status: payload.validationSummary.shouldReview || !payload.totalsMatch ? 'review_needed' : 'approved',
            extraction_confidence: payload.validationSummary.qualityScore,
            parser_version: 'node-parser-v2',
            model_name: payload.modelName,
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
        extraction_confidence: 85,
        validation_flags: computeValidationFlags(row),
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

/** True if col 0 of a data row looks like a valid product MARKS value */
function isValidMarks(raw: string): boolean {
  const first = raw.split('\n')[0].trim()
  if (!first) return false
  if (first.length < 3) return false
  if (/\s/.test(first)) return false
  if (/[¥￥]/.test(first)) return false
  if (/[\\/]/.test(first)) return false
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
  const isPackingList =
    allKeys.has('MARKS') || allKeys.has('T.QTY') || allKeys.has('U.PRICE (RMB)')

  logImport('importProducts: incoming rows=', rows.length, 'isPackingList=', isPackingList)
  logImport(
    'column keys (sample):',
    [...allKeys].filter(k => !k.startsWith('__col')).slice(0, 24),
    'has __col*',
    [...allKeys].some(k => k.startsWith('__col'))
  )
  if (rows[0]) {
    logImport('first raw row keys:', Object.keys(rows[0]), 'MARKS=', String(rows[0].MARKS ?? '').slice(0, 40))
  }

  let skippedInvalidMarks = 0
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
      if (rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX) || rawSku.startsWith(STAGE_TOTAL_MARKER_PREFIX)) {
        const title = rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX)
          ? rawSku.slice(STAGE_SECTION_MARKER_PREFIX.length)
          : rawSku.slice(STAGE_TOTAL_MARKER_PREFIX.length)
        if (rawSku.startsWith(STAGE_SECTION_MARKER_PREFIX) && !isValidStageSectionTitle(title)) {
          logImport('skip malformed stage marker:', title.slice(0, 160))
          continue
        }
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

      if (isGoodsLeftHeader(rawSku)) {
        continue
      }

      if (isRepackagedSectionHeader(rawSku)) {
        // Repacked-goods section marker — stop importing here.
        logImport('importProducts: hit repacked section boundary, stopping row processing')
        break
      }

      // Skip non-product rows: totals, payment lines, page headers, blank rows
      if (!isValidMarks(rawSku)) {
        skippedInvalidMarks++
        if (invalidMarksSamples.length < 10)
          invalidMarksSamples.push(String(rawSku).replace(/\n/g, '\\n').slice(0, 120))
        continue
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
      const isShifted = !!packingField && !/\//.test(packingField)

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
        cost_price = num(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? '')
        total_amount_rmb = numOrNull(r['T.AMOUNT'])
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
    'skipped (invalid MARKS):',
    skippedInvalidMarks,
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
    const flags = computeValidationFlags(row)
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
  const validationSummary = summarizeValidation(mapped)
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

  const totalsMatch = !totalsDiff || (
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

  // Insert every row as-is — no deduplication. Duplicate SKUs/marks from the
  // same PDF (e.g. same item in different containers or sizes) are all stored.
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
        extraction_flags: computeValidationFlags(row),
      }
    })
    const { error } = await withSupabaseRetry(
      () => supabase.from('products').insert(chunk),
      `importProducts chunk ${Math.floor(i / CHUNK) + 1}`
    )
    if (error) {
      // Backward-compatible fallback while migrations are being rolled out.
      if (
        error.message.includes('source_document_id') ||
        error.message.includes('source_document_item_id') ||
        error.message.includes('extraction_confidence') ||
        error.message.includes('extraction_flags')
      ) {
        const fallbackChunk = mapped.slice(i, i + CHUNK)
        const { error: fallbackErr } = await withSupabaseRetry(
          () => supabase.from('products').insert(fallbackChunk),
          `importProducts fallback chunk ${Math.floor(i / CHUNK) + 1}`
        )
        if (fallbackErr) throw new Error(fallbackErr.message)
      } else {
        throw new Error(error.message)
      }
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
    importedCount: mapped.length,
    llmAttempts,
    llmAligned: llmApplied,
    aiMode,
    totalsMatch,
    totalsDiff,
  }
}

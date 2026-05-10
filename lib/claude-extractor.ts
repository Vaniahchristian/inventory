import Anthropic from '@anthropic-ai/sdk'
import { DocType, getPromptForDocType } from './prompts'
import { callLlm } from './llm-client'
import { coerceDocument, coerceProductArray } from './extract-coerce'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

export interface ExtractedDocument {
  doc_number: string | null
  client_id: string | null
  container_no: string | null
  document_date?: string | null
  document_type: DocType
  footer_totals: {
    total_cartons: number | null
    total_cbm: number | null
    total_weight_kg: number | null
    total_amount_rmb: number | null
    total_amount_usd: number | null
    exchange_rate: number | null
    goods_balance_usd: number | null
    freight_usd: number | null
    total_balance_usd: number | null
  }
  payments: Array<{
    payment_date: string | null
    amount_usd: number | null
    payment_type: string
  }>
}

export interface ExtractedProduct {
  line_no: number | null
  marks: string | null
  shop: string | null
  item_code: string | null
  description: string | null
  packaging: string | null
  qty_per_carton: number | null
  total_cartons: number | null
  total_qty: number | null
  unit_price_rmb: number | null
  total_amount_rmb: number | null
  dim_l_cm: number | null
  dim_w_cm: number | null
  dim_h_cm: number | null
  unit_cbm: number | null
  total_cbm: number | null
  unit_weight_kg: number | null
  total_weight_kg: number | null
  barcode: string | null
  warehouse: string | null
  box_no_start: number | null
  box_no_end: number | null
  section: string
  remarks: string | null
  /** PDF 送货单号 / DEL NO — batch delivery reference */
  delivery_no: string | null
  /** PDF 客户货号 / CUS NO */
  customer_item_ref: string | null
  /** PDF 产品货号 / ITEM NO (manufacturer SKU); mirrors item_code when linked */
  source_item_no: string | null
  /** PDF UNIT / 单位 */
  unit: string | null
  /** PDF ITEM 品名 column when distinct from English description */
  product_name_local: string | null
  /** PDF MATERIAL / 材质 */
  material: string | null
  /** Optional keyed snapshot of parsed cells for audit */
  source_cells: Record<string, string> | null
}

export interface ClaudeExtractionResult {
  document: ExtractedDocument
  products: ExtractedProduct[]
  model: string
  input_tokens: number
  output_tokens: number
  truncated: boolean
}

export interface ClaudeChunkingStats {
  chunk_count: number
  subchunk_count: number
  successful_chunks: number
  failed_chunks: number
  truncated_chunks: number
}

/**
 * Extract from raw file bytes — PDF or image — sent directly to Claude.
 * Skips Google Vision OCR entirely; Claude reads the visual layout.
 */
export async function extractFromBuffer(
  fileBuffer: Buffer,
  mediaType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp',
  docType: DocType,
  onProgress?: (elapsedMs: number, charsReceived: number) => void
): Promise<ClaudeExtractionResult> {
  const base64Data = fileBuffer.toString('base64')
  const maxTokens = Math.max(4096, Number(process.env.CLAUDE_MAX_TOKENS ?? 32000))
  const prompt = getVisualPromptForDocType(docType)

  console.log(`[claude-extractor] visual stream — media_type: ${mediaType} doc_type: ${docType} file_bytes: ${fileBuffer.length} max_tokens: ${maxTokens}`)

  const contentBlock = mediaType === 'application/pdf'
    ? {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data },
      }
    : {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/webp', data: base64Data },
      }

  const callStart = Date.now()

  // .stream() avoids the SDK's "Streaming is required" guard on large payloads.
  // Text events fire as tokens arrive — used to emit progress and keep the
  // server-side connection alive during long extractions.
  const stream = anthropic.beta.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    betas: ['pdfs-2024-09-25'],
    messages: [
      {
        role: 'user',
        content: [contentBlock as any, { type: 'text', text: prompt }],
      },
    ],
  })

  let accumulated = ''
  let lastProgressEmit = 0
  const PROGRESS_INTERVAL_MS = 5_000

  stream.on('text', (text) => {
    accumulated += text
    if (onProgress) {
      const now = Date.now()
      if (now - lastProgressEmit >= PROGRESS_INTERVAL_MS) {
        lastProgressEmit = now
        onProgress(now - callStart, accumulated.length)
      }
    }
  })

  stream.on('error', (err: any) => {
    console.error(`[claude-extractor] stream error — status: ${err?.status ?? 'unknown'} message: ${err?.message ?? err}`)
    if (err?.error) console.error(`[claude-extractor] error body: ${JSON.stringify(err.error)}`)
  })

  let finalResponse: Awaited<ReturnType<typeof stream.finalMessage>>
  try {
    finalResponse = await stream.finalMessage()
  } catch (err: any) {
    const callMs = Date.now() - callStart
    console.error(`[claude-extractor] stream failed after ${callMs}ms — status: ${err?.status ?? 'unknown'} message: ${err?.message ?? err}`)
    if (err?.error) console.error(`[claude-extractor] error body: ${JSON.stringify(err.error)}`)
    if (err?.headers) console.error(`[claude-extractor] request_id: ${err.headers?.['request-id'] ?? err.headers?.['x-request-id'] ?? 'n/a'}`)
    throw err
  }

  const callMs = Date.now() - callStart
  // Use accumulated stream text rather than finalResponse.content — same data
  // but avoids a redundant base64 decode on large responses.
  const rawContent = accumulated || (finalResponse.content[0].type === 'text' ? finalResponse.content[0].text : '')

  console.log(`[claude-extractor] done in ${callMs}ms — chars: ${rawContent.length} input_tokens: ${finalResponse.usage.input_tokens} output_tokens: ${finalResponse.usage.output_tokens} stop_reason: ${finalResponse.stop_reason}`)

  const truncated = finalResponse.stop_reason === 'max_tokens'
  if (truncated) console.warn('[claude-extractor] WARNING: hit max_tokens — output may be incomplete')

  let parsed: { document: ExtractedDocument; products: ExtractedProduct[] }
  try {
    parsed = parseClaudeResponse(rawContent)
  } catch (parseErr: any) {
    console.error(`[claude-extractor] JSON parse failed — raw_length: ${rawContent.length} error: ${parseErr?.message}`)
    console.error(`[claude-extractor] raw_response: ${rawContent}`)
    throw parseErr
  }

  console.log(`[claude-extractor] extracted ${parsed.products.length} rows`)

  return {
    document: parsed.document,
    products: parsed.products,
    model: finalResponse.model,
    input_tokens: finalResponse.usage.input_tokens,
    output_tokens: finalResponse.usage.output_tokens,
    truncated,
  }
}

/**
 * Fallback: extract from OCR text lines (used when file-based extraction is unavailable).
 */
export async function extractWithClaude(
  ocrLines: string[],
  docType: DocType,
  label = 'chunk'
): Promise<ClaudeExtractionResult> {
  const ocrText = ocrLines.join('\n')
  const prompt = getPromptForDocType(docType, ocrText)
  const maxTokens = Math.max(4096, Number(process.env.CLAUDE_MAX_TOKENS ?? 32000))

  console.log(`[claude-extractor] ${label} — doc_type=${docType} lines=${ocrLines.length} prompt_chars=${prompt.length} max_tokens=${maxTokens}`)

  const callStart = Date.now()
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  const response = await stream.finalMessage()
  const callMs = Date.now() - callStart

  const rawContent = response.content[0].type === 'text' ? response.content[0].text : ''

  console.log(`[claude-extractor] ${label} — done in ${callMs}ms`)
  console.log(`[claude-extractor] ${label} — input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens} stop_reason=${response.stop_reason}`)
  console.log(`[claude-extractor] ${label} — response_preview: ${rawContent.slice(0, 300)}`)

  const truncated = response.stop_reason === 'max_tokens'
  if (truncated) {
    console.warn(`[claude-extractor] ${label} — WARNING: hit max_tokens, output may be incomplete`)
  }

  const parsed = parseClaudeResponse(rawContent)
  console.log(`[claude-extractor] ${label} — parsed ${parsed.products.length} rows, parse_errors=${parsed.products.length === 0 ? 'POSSIBLY — check response_preview above' : 'none'}`)

  return {
    document: parsed.document,
    products: parsed.products,
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    truncated,
  }
}

export async function extractWithClaudeChunked(
  ocrLines: string[],
  docType: DocType
): Promise<ClaudeExtractionResult & { chunking: ClaudeChunkingStats }> {
  const chunks = buildRowAwareChunks(
    ocrLines,
    Math.max(20, Number(process.env.CLAUDE_CHUNK_TARGET_ROWS ?? 120)),
    Math.max(300, Number(process.env.CLAUDE_CHUNK_MAX_LINES ?? 1400))
  )

  if (chunks.length === 0) {
    return {
      document: defaultDocumentFor(docType),
      products: [],
      model: 'claude-sonnet-4-6',
      input_tokens: 0,
      output_tokens: 0,
      truncated: false,
      chunking: {
        chunk_count: 0,
        subchunk_count: 0,
        successful_chunks: 0,
        failed_chunks: 0,
        truncated_chunks: 0,
      },
    }
  }

  const allProducts: ExtractedProduct[] = []
  let doc: ExtractedDocument | null = null
  let model = 'claude-sonnet-4-6'
  let inputTokens = 0
  let outputTokens = 0
  let anyTruncated = false
  let failedChunks = 0
  let successfulChunks = 0
  let truncatedChunks = 0
  let subchunkCount = 0
  let claudeUnavailableForRequest = false

  const chunkDeadlineMs = Number(process.env.EXTRACT_CHUNK_TIMEOUT_MS ?? 300_000) // 5 min default
  const deadline = Date.now() + chunkDeadlineMs

  console.log(`[claude-extractor] chunked — total_lines=${ocrLines.length} chunks=${chunks.length} chunk_sizes=${chunks.map(c => c.length).join(',')} deadline_ms=${chunkDeadlineMs}`)

  for (let i = 0; i < chunks.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`[claude-extractor] chunk deadline exceeded — stopping at chunk ${i + 1}/${chunks.length} with ${allProducts.length} rows already extracted`)
      break
    }
    const chunk = chunks[i]
    const chunkLabel = `chunk ${i + 1}/${chunks.length}`
    console.log(`[claude-extractor] ── ${chunkLabel} start (lines=${chunk.length}) ──`)
    if (claudeUnavailableForRequest) {
      try {
        console.log(`[claude-extractor] ${chunkLabel} using fallback-only path (Claude unavailable)`)
        const fallback = await extractWithFallbackLlm(chunk, docType)
        model = fallback.model
        inputTokens += fallback.input_tokens
        outputTokens += fallback.output_tokens
        if (fallback.truncated) {
          truncatedChunks++
          anyTruncated = true
        }
        if (!doc) doc = fallback.document
        allProducts.push(...fallback.products)
        successfulChunks++
        console.log(`[claude-extractor] ${chunkLabel} fallback done — rows=${fallback.products.length} running_total=${allProducts.length}`)
        continue
      } catch (fallbackErr: any) {
        failedChunks++
        console.warn(
          `[claude-extractor] ${chunkLabel} fallback-only path failed: ${fallbackErr?.message ?? fallbackErr}`
        )
        continue
      }
    }
    try {
      const result = await extractWithClaude(chunk, docType, chunkLabel)
      model = result.model
      inputTokens += result.input_tokens
      outputTokens += result.output_tokens
      if (result.truncated) {
        truncatedChunks++
        anyTruncated = true
      }
      if (!doc) doc = result.document
      allProducts.push(...result.products)
      successfulChunks++
      console.log(`[claude-extractor] ${chunkLabel} done — rows=${result.products.length} running_total=${allProducts.length}`)

      if (result.truncated && chunk.length >= 250) {
        const subchunks = splitChunk(chunk)
        if (subchunks.length > 1) {
          subchunkCount += subchunks.length
          console.log(`[claude-extractor] ${chunkLabel} truncated → splitting into ${subchunks.length} subchunks`)
          for (const [j, sub] of subchunks.entries()) {
            const subLabel = `chunk ${i + 1}.${j + 1}/${subchunks.length}`
            try {
              const subResult = await extractWithClaude(sub, docType, subLabel)
              inputTokens += subResult.input_tokens
              outputTokens += subResult.output_tokens
              if (subResult.truncated) {
                truncatedChunks++
                anyTruncated = true
              }
              if (!doc) doc = subResult.document
              allProducts.push(...subResult.products)
              successfulChunks++
              console.log(`[claude-extractor] ${subLabel} done — rows=${subResult.products.length} running_total=${allProducts.length}`)
            } catch (subErr: any) {
              failedChunks++
              console.warn(`[claude-extractor] ${subLabel} failed: ${subErr?.message ?? subErr}`)
            }
          }
        }
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      console.warn(`[claude-extractor] ${chunkLabel} failed: ${msg}`)
      if (isAnthropicBillingError(msg)) {
        claudeUnavailableForRequest = true
        console.warn('[claude-extractor] Anthropic billing/credit issue detected; switching remaining chunks to fallback-only')
      }
      if (shouldTryFallbackModel(msg)) {
        try {
          console.log(`[claude-extractor] ${chunkLabel} trying fallback model...`)
          const fallback = await extractWithFallbackLlm(chunk, docType)
          model = fallback.model
          inputTokens += fallback.input_tokens
          outputTokens += fallback.output_tokens
          if (fallback.truncated) {
            truncatedChunks++
            anyTruncated = true
          }
          if (!doc) doc = fallback.document
          allProducts.push(...fallback.products)
          successfulChunks++
          console.log(`[claude-extractor] ${chunkLabel} fallback done — rows=${fallback.products.length} running_total=${allProducts.length}`)
          continue
        } catch (fallbackErr: any) {
          console.warn(
            `[claude-extractor] ${chunkLabel} fallback failed: ${fallbackErr?.message ?? fallbackErr}`
          )
        }
      }
      failedChunks++
    }
  }

  const deduped = dedupeProducts(allProducts)
  console.log(`[claude-extractor] chunked complete — raw_rows=${allProducts.length} deduped_rows=${deduped.length} successful=${successfulChunks} failed=${failedChunks} truncated_chunks=${truncatedChunks} input_tokens=${inputTokens} output_tokens=${outputTokens}`)

  return {
    document: doc ?? defaultDocumentFor(docType),
    products: deduped,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    truncated: anyTruncated,
    chunking: {
      chunk_count: chunks.length,
      subchunk_count: subchunkCount,
      successful_chunks: successfulChunks,
      failed_chunks: failedChunks,
      truncated_chunks: truncatedChunks,
    },
  }
}

function shouldTryFallbackModel(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('credit balance is too low') ||
    m.includes('insufficient') ||
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('fetch failed') ||
    m.includes('network')
  )
}

function isAnthropicBillingError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('credit balance is too low') ||
    m.includes('plans & billing') ||
    m.includes('billing') ||
    m.includes('insufficient credits')
  )
}

async function extractWithFallbackLlm(
  ocrLines: string[],
  docType: DocType
): Promise<ClaudeExtractionResult> {
  const ocrText = ocrLines.join('\n')
  const basePrompt = getPromptForDocType(docType, ocrText)
  const strictPrompt =
    `${basePrompt}\n\n` +
    'IMPORTANT: Return ONLY a raw JSON object. No markdown fences, no commentary.'

  const messages = [
    { role: 'system' as const, content: 'You are a strict JSON extraction engine.' },
    { role: 'user' as const, content: strictPrompt },
  ]
  const llm = await callLlm(messages, {
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 12000),
    retries: 1,
  })
  if (!llm?.content) {
    const waitMs = Math.max(1000, Number(process.env.LLM_FALLBACK_RETRY_WAIT_MS ?? 4000))
    console.log(`[claude-extractor] fallback providers unavailable, waiting ${waitMs}ms and retrying once`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
    const retry = await callLlm(messages, {
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 12000),
      retries: 1,
    })
    if (!retry?.content) throw new Error('No fallback LLM response')
    const parsedRetry = parseClaudeResponse(retry.content)
    return {
      document: parsedRetry.document,
      products: parsedRetry.products,
      model: retry.provider,
      input_tokens: 0,
      output_tokens: 0,
      truncated: false,
    }
  }

  const parsed = parseClaudeResponse(llm.content)
  return {
    document: parsed.document,
    products: parsed.products,
    model: llm.provider,
    input_tokens: 0,
    output_tokens: 0,
    truncated: false,
  }
}

function buildRowAwareChunks(lines: string[], targetRows: number, maxLines: number): string[][] {
  const normalized = lines.map(l => l.trim()).filter(Boolean)
  if (!normalized.length) return []

  const overlapLines = Math.max(0, Number(process.env.CLAUDE_CHUNK_OVERLAP_LINES ?? 40))
  const chunks: string[][] = []
  let current: string[] = []
  let rowAnchors = 0

  for (const line of normalized) {
    const isAnchor = looksLikeRowAnchor(line)
    if (isAnchor && current.length > 0 && (rowAnchors >= targetRows || current.length >= maxLines)) {
      chunks.push(current)
      const overlap = overlapLines > 0 ? current.slice(Math.max(0, current.length - overlapLines)) : []
      current = [...overlap]
      rowAnchors = overlap.filter(looksLikeRowAnchor).length
    }
    if (current.length >= maxLines) {
      chunks.push(current)
      const overlap = overlapLines > 0 ? current.slice(Math.max(0, current.length - overlapLines)) : []
      current = [...overlap]
      rowAnchors = overlap.filter(looksLikeRowAnchor).length
    }
    current.push(line)
    if (isAnchor) rowAnchors++
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function splitChunk(lines: string[]): string[][] {
  if (lines.length < 2) return [lines]
  const mid = Math.floor(lines.length / 2)
  return [lines.slice(0, mid), lines.slice(mid)]
}

function looksLikeRowAnchor(line: string): boolean {
  if (!line) return false
  return (
    /^MS-\d{2,4}-\d{1,4}\b/i.test(line) ||
    /^\d{1,4}[\.\)]\s/.test(line) ||
    /^ITEM\s*NO\.?/i.test(line) ||
    /^[A-Z0-9]{2,6}-[A-Z0-9]{1,6}-\d{1,5}\b/i.test(line)
  )
}

function dedupeProducts(products: ExtractedProduct[]): ExtractedProduct[] {
  const seen = new Set<string>()
  const out: ExtractedProduct[] = []
  for (const p of products) {
    const key = [
      p.section ?? '',
      p.marks ?? '',
      p.item_code ?? '',
      p.description ?? '',
      p.total_cartons ?? '',
      p.total_qty ?? '',
      p.total_amount_rmb ?? '',
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function defaultDocumentFor(docType: DocType): ExtractedDocument {
  return {
    doc_number: null,
    client_id: null,
    container_no: null,
    document_date: null,
    document_type: docType,
    footer_totals: {
      total_cartons: null,
      total_cbm: null,
      total_weight_kg: null,
      total_amount_rmb: null,
      total_amount_usd: null,
      exchange_rate: null,
      goods_balance_usd: null,
      freight_usd: null,
      total_balance_usd: null,
    },
    payments: [],
  }
}

function parseClaudeResponse(raw: string): { document: ExtractedDocument; products: ExtractedProduct[] } {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Claude response contains no JSON object')
  }

  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1)

  let parsed: any
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    console.error('[claude-extractor] JSON parse failed, attempting repair...')
    const repaired = repairJson(jsonStr)
    parsed = JSON.parse(repaired)
  }

  if (!parsed.document || !Array.isArray(parsed.products)) {
    throw new Error('Claude response missing required "document" or "products" fields')
  }

  const document = coerceDocument(parsed.document)
  const products = coerceProductArray(parsed.products)
  console.log(`[claude-extractor] parsed rows: ${products.length}`)

  return { document, products }
}

function repairJson(str: string): string {
  let result = str.trim()

  const openArrays = (result.match(/\[/g) || []).length
  const closeArrays = (result.match(/\]/g) || []).length
  const missingArrayClose = openArrays - closeArrays

  const openObjects = (result.match(/\{/g) || []).length
  const closeObjects = (result.match(/\}/g) || []).length
  const missingObjectClose = openObjects - closeObjects

  result = result.replace(/,\s*$/, '')

  for (let i = 0; i < missingArrayClose; i++) result += ']'
  for (let i = 0; i < missingObjectClose; i++) result += '}'

  return result
}

// ── Visual prompts (no OCR text — Claude reads the document directly) ──────

function getVisualPromptForDocType(docType: DocType): string {
  const shared = `
CRITICAL RULES:
- Extract EVERY product row visible in the table. Do not skip rows with 0 quantities.
- Return ONLY a raw JSON object. No markdown fences, no explanation, no preamble.
- All numeric fields must be plain numbers. Strip units: "0.09CBM" → 0.09, "20.9KGS" → 20.9, "¥32" → 32.
- Use null for any field that is genuinely missing or not visible.
- Never invent data. If a field is blank in the document, set it to null.
- Read the entire document including all pages. The "products" array must contain ALL rows.`

  if (docType === 'sales_order') {
    return `You are a strict data extraction engine. Read this Chinese sales order (销售单) document and extract all product rows.

Columns to find: 序号 (line_no), 产品货号 (item_code), 描述 (description), 总箱数 (total_cartons), 每箱数量 (qty_per_carton), 总数量 (total_qty), 单价 (unit_price_rmb), 金额 (total_amount_rmb), 长/宽/高 cm (dim_l/w/h), 体积 (unit_cbm/total_cbm), 重量 (unit/total weight kg), 条形码 (barcode), 仓位 (warehouse).

Return a JSON object with EXACTLY this structure:
{
  "document": {
    "doc_number": null,
    "client_id": null,
    "container_no": null,
    "document_date": null,
    "document_type": "sales_order",
    "footer_totals": { "total_cartons": null, "total_cbm": null, "total_weight_kg": null, "total_amount_rmb": null, "total_amount_usd": null, "exchange_rate": null, "goods_balance_usd": null, "freight_usd": null, "total_balance_usd": null },
    "payments": []
  },
  "products": [{
    "line_no": 1, "marks": null, "shop": null, "item_code": null, "description": null,
    "packaging": null, "qty_per_carton": null, "total_cartons": null, "total_qty": null,
    "unit_price_rmb": null, "total_amount_rmb": null,
    "dim_l_cm": null, "dim_w_cm": null, "dim_h_cm": null,
    "unit_cbm": null, "total_cbm": null, "unit_weight_kg": null, "total_weight_kg": null,
    "barcode": null, "warehouse": null, "box_no_start": null, "box_no_end": null,
    "section": "shipped", "remarks": null
  }]
}
${shared}`
  }

  return `You are a strict data extraction engine. Read this container packing list / manifest document and extract all product rows.

Columns to find: MARKS (唛头), SHOP# (supplier name), ITEM NO., DESCRIPTION OF GOODS, PACKING (e.g. "2pcs/ctn"), T.CTN (total cartons), T.QTY (total pieces), H/W/L (dimensions cm), UNIT CBM, T.CBM, UNIT WEIGHT (kg), T.WEIGHT (kg), U.PRICE (RMB), T.AMOUNT (RMB), BOX NO range.

Sections: main shipped goods only use section="shipped". "GOODS LEFT IN SANCARGO" → section="left_in_warehouse". "GOODS STUFFED INTO THIS CONTAINER (REPACKED GOODS)" / repacked-banner rows → section="repacked" (not inventory — same exclusion as goods-left).

Return a JSON object with EXACTLY this structure:
{
  "document": {
    "doc_number": null,
    "client_id": null,
    "container_no": null,
    "document_date": null,
    "document_type": "container_manifest",
    "footer_totals": { "total_cartons": null, "total_cbm": null, "total_weight_kg": null, "total_amount_rmb": null, "total_amount_usd": null, "exchange_rate": null, "goods_balance_usd": null, "freight_usd": null, "total_balance_usd": null },
    "payments": [{ "payment_date": null, "amount_usd": null, "payment_type": "deposit" }]
  },
  "products": [{
    "line_no": 1, "marks": null, "shop": null, "item_code": null, "description": null,
    "packaging": null, "qty_per_carton": null, "total_cartons": null, "total_qty": null,
    "unit_price_rmb": null, "total_amount_rmb": null,
    "dim_l_cm": null, "dim_w_cm": null, "dim_h_cm": null,
    "unit_cbm": null, "total_cbm": null, "unit_weight_kg": null, "total_weight_kg": null,
    "barcode": null, "warehouse": null, "box_no_start": null, "box_no_end": null,
    "section": "shipped", "remarks": null
  }]
}

CONTAINER MANIFEST SPECIFIC:
- marks: the MARKS/唛头 column (e.g. "37-T-101-1", "MS-301-1")
  MARKS INHERITANCE: Sub-rows for accessories/parts of a parent item do not repeat the MARKS.
  Always propagate the most recent MARKS value down to every sub-row that lacks its own MARKS.
- shop: the SHOP# column — supplier name, NOT a warehouse
- box_no_start / box_no_end: parse from BOX NO column (e.g. "170-278" → start:170, end:278)
- payments: extract all payment lines at bottom (date, amount USD, type)

SHARED / MERGED CELLS — CRITICAL FOR ACCURATE CARTON COUNTS:
T.CTN is often a single merged cell spanning several sub-rows (e.g. "1CTNS" covers rows 2–5
because those parts share one physical carton). Rules:
  1. Assign the T.CTN to the FIRST row of the group (or where the cell visually sits).
  2. All other sub-rows in that group must get total_cartons = 0 (not null).
  3. A sub-row with its own distinct CTN cell keeps that value.
  4. Rows with 0.000CBM and 0.0KGS are valid packed-inside-parent rows — extract CBM/weight as 0.
  5. The sum of all total_cartons must equal the document footer total.
${shared}`
}

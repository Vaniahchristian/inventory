import type { ExtractedDocument, ExtractedProduct } from './claude-extractor'

const REDUCTO_BASE = 'https://platform.reducto.ai'
const REDUCTO_PARSE_TIMEOUT_MS = Number(process.env.REDUCTO_PARSE_TIMEOUT_MS ?? 360000)
const REDUCTO_PARSE_MAX_ATTEMPTS = Math.max(1, Number(process.env.REDUCTO_PARSE_MAX_ATTEMPTS ?? 2))
// Long /extract calls still need headroom (slow networks, large PDFs)
const REDUCTO_EXTRACT_TIMEOUT_MS = Number(process.env.REDUCTO_EXTRACT_TIMEOUT_MS ?? 800000)
const REDUCTO_EXTRACT_MAX_ATTEMPTS = Math.max(1, Number(process.env.REDUCTO_EXTRACT_MAX_ATTEMPTS ?? 2))

interface ReductoChunk {
  content: string
  blocks: Array<{ type: string; content: string; confidence?: string }>
}

interface ReductoParseResult {
  job_id: string
  duration: number
  usage: { num_pages: number; credits: number }
  result: { chunks: ReductoChunk[] }
}

export interface ReductoExtractResult {
  text: string
  pageCount: number
  jobId: string
  credits: number
}

export function isReductoConfigured(): boolean {
  return Boolean(process.env.REDUCTO_API_KEY)
}

export async function extractWithReducto(
  fileBuffer: Buffer,
  fileName: string,
  debugId?: string
): Promise<ReductoExtractResult> {
  const tag = debugId ? `[reducto][${debugId}]` : '[reducto]'
  const apiKey = process.env.REDUCTO_API_KEY
  if (!apiKey) throw new Error('REDUCTO_API_KEY not set')

  // Step 1: Upload the file
  const uploadForm = new FormData()
  uploadForm.append(
    'file',
    new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' }),
    fileName
  )

  const uploadStart = Date.now()
  let uploadRes: Response
  try {
    uploadRes = await fetch(`${REDUCTO_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: uploadForm,
    })
  } catch (err: any) {
    throw new Error(`Reducto upload network error: ${err?.message ?? err}`)
  }
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => uploadRes.statusText)
    throw new Error(`Reducto upload failed (${uploadRes.status}): ${err}`)
  }
  const { file_id } = await uploadRes.json()
  console.log(`${tag} uploaded in ${Date.now() - uploadStart}ms — file_id: ${file_id}`)

  // Step 2: Parse
  // HTML table format preserves colspan/rowspan — critical for merged cells (T.CTN, MARKS).
  // Agentic table scope adds AI-powered table structure understanding.
  const parseStart = Date.now()
  const parseBody = JSON.stringify({
    input: file_id,
    formatting: {
      table_output_format: 'html',
      add_page_markers: false,
    },
    enhance: {
      agentic: [{ scope: 'table' }],
    },
    settings: {
      extraction_mode: 'hybrid',
    },
  })

  let parseRes: Response | null = null
  let lastNetworkError: unknown = null
  for (let attempt = 1; attempt <= REDUCTO_PARSE_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REDUCTO_PARSE_TIMEOUT_MS)
    try {
      parseRes = await fetch(`${REDUCTO_BASE}/parse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: parseBody,
        signal: controller.signal,
      })
      lastNetworkError = null
      break
    } catch (err: any) {
      lastNetworkError = err
      const detail = err?.name === 'AbortError'
        ? `timeout after ${REDUCTO_PARSE_TIMEOUT_MS}ms`
        : err?.message ?? String(err)
      console.warn(`${tag} parse attempt ${attempt}/${REDUCTO_PARSE_MAX_ATTEMPTS} network error: ${detail}`)
      if (attempt < REDUCTO_PARSE_MAX_ATTEMPTS) {
        const backoffMs = attempt * 2000
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  if (!parseRes) {
    const msg = (lastNetworkError as any)?.message ?? String(lastNetworkError)
    throw new Error(`Reducto parse network error: ${msg}`)
  }
  if (!parseRes.ok) {
    const err = await parseRes.text().catch(() => parseRes.statusText)
    throw new Error(`Reducto parse failed (${parseRes.status}): ${err}`)
  }
  const parsedUnknown = await parseRes.json()
  const parsed = parsedUnknown as Partial<ReductoParseResult> & Record<string, unknown>
  const topKeys = Object.keys(parsed)
  const chunkCount = Array.isArray(parsed?.result?.chunks) ? parsed.result!.chunks.length : -1
  const firstChunkKeys =
    Array.isArray(parsed?.result?.chunks) && parsed.result!.chunks[0] && typeof parsed.result!.chunks[0] === 'object'
      ? Object.keys(parsed.result!.chunks[0] as unknown as Record<string, unknown>)
      : []
  console.log(
    `${tag} parse payload keys: ${topKeys.join(', ')}; chunks=${chunkCount}; first_chunk_keys=${firstChunkKeys.join(', ')}`
  )
  if (!parsed?.result || !Array.isArray(parsed.result.chunks) || !parsed?.usage || !parsed?.job_id) {
    throw new Error(
      `Reducto parse response invalid: has_result=${Boolean(parsed?.result)} has_chunks_array=${Array.isArray(parsed?.result?.chunks)} has_usage=${Boolean(parsed?.usage)} has_job_id=${Boolean(parsed?.job_id)}`
    )
  }
  console.log(
    `${tag} parsed in ${Date.now() - parseStart}ms (api: ${parsed.duration ?? 'n/a'}s) — pages: ${parsed.usage.num_pages} credits: ${parsed.usage.credits}`
  )

  // Concatenate all chunk content — Reducto returns markdown prose + HTML table blocks
  const text = parsed.result.chunks
    .map(chunk => (typeof chunk?.content === 'string' ? chunk.content : ''))
    .filter(Boolean)
    .join('\n\n')

  return {
    text,
    pageCount: parsed.usage.num_pages,
    jobId: parsed.job_id,
    credits: parsed.usage.credits,
  }
}

// ── Structured extraction schema ──────────────────────────────────────────────
// Mirrors ExtractedDocument + ExtractedProduct so Reducto returns typed JSON
// directly — no Claude text extraction needed.
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    document: {
      type: 'object',
      properties: {
        doc_number: { type: ['string', 'null'] },
        client_id: { type: ['string', 'null'] },
        container_no: { type: ['string', 'null'] },
        document_date: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD or null' },
        document_type: { type: 'string', enum: ['sales_order', 'packing_list', 'invoice', 'unknown'] },
        footer_totals: {
          type: 'object',
          properties: {
            total_cartons: { type: ['number', 'null'] },
            total_cbm: { type: ['number', 'null'] },
            total_weight_kg: { type: ['number', 'null'] },
            total_amount_rmb: { type: ['number', 'null'] },
            total_amount_usd: { type: ['number', 'null'] },
            exchange_rate: { type: ['number', 'null'] },
            goods_balance_usd: { type: ['number', 'null'] },
            freight_usd: { type: ['number', 'null'] },
            total_balance_usd: { type: ['number', 'null'] },
          },
        },
        payments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              payment_date: { type: ['string', 'null'] },
              amount_usd: { type: ['number', 'null'] },
              payment_type: { type: 'string' },
            },
          },
        },
      },
    },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line_no: { type: ['integer', 'null'], description: 'Sequential row number from the document (1-indexed)' },
          marks: { type: ['string', 'null'], description: 'Product marks/code — propagate down from merged cells to every sub-row that lacks its own value' },
          shop: { type: ['string', 'null'] },
          item_code: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          packaging: { type: ['string', 'null'] },
          qty_per_carton: { type: ['number', 'null'] },
          total_cartons: { type: ['number', 'null'] },
          total_qty: { type: ['number', 'null'] },
          unit_price_rmb: { type: ['number', 'null'] },
          total_amount_rmb: { type: ['number', 'null'] },
          dim_l_cm: { type: ['number', 'null'] },
          dim_w_cm: { type: ['number', 'null'] },
          dim_h_cm: { type: ['number', 'null'] },
          unit_cbm: { type: ['number', 'null'] },
          total_cbm: { type: ['number', 'null'] },
          unit_weight_kg: { type: ['number', 'null'] },
          total_weight_kg: { type: ['number', 'null'] },
          barcode: { type: ['string', 'null'] },
          warehouse: { type: ['string', 'null'] },
          box_no_start: { type: ['integer', 'null'] },
          box_no_end: { type: ['integer', 'null'] },
          section: { type: 'string', enum: ['shipped', 'left_in_warehouse', 'repacked'] },
          remarks: { type: ['string', 'null'] },
        },
        required: ['line_no', 'marks', 'item_code', 'description', 'total_cartons', 'total_qty', 'total_amount_rmb', 'section'],
      },
    },
  },
  required: ['document', 'products'],
}

const EXTRACTION_SYSTEM_PROMPT = `
You are extracting structured data from a Chinese packing list or sales order. Read EVERY product row — do not skip any.

SECTION CLASSIFICATION:
- section defaults to "shipped"
- Use "left_in_warehouse" for ALL rows under "GOODS LEFT IN SANCARGO", "LEFT IN WAREHOUSE", or similar
- Use "repacked" for ALL rows under the yellow banner "GOODS STUFFED INTO THIS CONTAINER (REPACKED GOODS)" / "REPACKED GOODS" / "REPACKAGED GOODS" and every green-highlighted row below it — these are NOT stored as inventory (same as goods left)
- NEVER assign left_in_warehouse or repacked to rows in the main NEW ORDER / shipped table above those section banners

YELLOW HIGHLIGHTED ROWS (subtotal bars):
- The document contains yellow/orange highlighted rows that show running subtotals (e.g. "1042CTNS | 70.125CBM | ¥327,239.30")
- These are SECTION SUBTOTALS, NOT product rows — do NOT add them to the products array
- footer_totals should come from the GRAND TOTAL at the very bottom of the entire document (the last total row covering all sections), NOT from per-section yellow bars

MARKS PROPAGATION:
- The MARKS column often spans multiple rows (merged cell) — copy the marks value down to every sub-row that has no marks of its own

OTHER RULES:
- All monetary amounts are in RMB (元/¥) unless explicitly labelled USD
- Dimensions in cm; convert from mm if needed (÷10)
- Weights in kg
- document_type: "sales_order" if header says SALES ORDER, "packing_list" if it says PACKING LIST, otherwise "unknown"
- Return null for any field that cannot be determined
`.trim()

export interface ReductoStructuredResult {
  document: ExtractedDocument
  products: ExtractedProduct[]
  pageCount: number
  jobId: string
  credits: number
}

export async function extractStructuredWithReducto(
  fileBuffer: Buffer,
  fileName: string,
  debugId?: string
): Promise<ReductoStructuredResult> {
  const tag = debugId ? `[reducto][${debugId}]` : '[reducto]'
  const apiKey = process.env.REDUCTO_API_KEY
  if (!apiKey) throw new Error('REDUCTO_API_KEY not set')

  // Step 1: Upload
  const uploadForm = new FormData()
  uploadForm.append(
    'file',
    new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' }),
    fileName
  )
  const uploadStart = Date.now()
  const uploadRes = await fetch(`${REDUCTO_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: uploadForm,
  })
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => uploadRes.statusText)
    throw new Error(`Reducto upload failed (${uploadRes.status}): ${errText}`)
  }
  const { file_id } = await uploadRes.json()
  console.log(`${tag} [structured] uploaded in ${Date.now() - uploadStart}ms — file_id: ${file_id}`)

  // Step 2: Extract structured JSON with schema — replaces Claude text extraction
  // Timeout + retry so a dropped connection doesn't silently fail
  const extractStart = Date.now()
  const extractBody = JSON.stringify({
    input: { file_id },
    instructions: {
      schema: EXTRACTION_SCHEMA,
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
    },
    settings: {
      // deep_extract is slower (often many minutes on large PDFs) but can improve row completeness.
      // Default off; set REDUCTO_DEEP_EXTRACT=1 to enable.
      deep_extract: process.env.REDUCTO_DEEP_EXTRACT === '1',
    },
  })

  let extractRes: Response | null = null
  let lastExtractNetworkError: unknown = null
  for (let attempt = 1; attempt <= REDUCTO_EXTRACT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REDUCTO_EXTRACT_TIMEOUT_MS)
    try {
      extractRes = await fetch(`${REDUCTO_BASE}/extract`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: extractBody,
        signal: controller.signal,
      })
      lastExtractNetworkError = null
      break
    } catch (err: any) {
      lastExtractNetworkError = err
      const detail = err?.name === 'AbortError'
        ? `timeout after ${REDUCTO_EXTRACT_TIMEOUT_MS}ms`
        : err?.message ?? String(err)
      console.warn(`${tag} extract attempt ${attempt}/${REDUCTO_EXTRACT_MAX_ATTEMPTS} network error: ${detail}`)
      if (attempt < REDUCTO_EXTRACT_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 2000))
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  if (!extractRes) {
    const msg = (lastExtractNetworkError as any)?.message ?? String(lastExtractNetworkError)
    throw new Error(`Reducto extract network error: ${msg}`)
  }
  if (!extractRes.ok) {
    const errText = await extractRes.text().catch(() => extractRes!.statusText)
    throw new Error(`Reducto extract failed (${extractRes.status}): ${errText}`)
  }
  const data = await extractRes.json()
  console.log(
    `${tag} [structured] done in ${Date.now() - extractStart}ms — pages: ${data?.usage?.num_pages} credits: ${data?.usage?.credits} extract_mode: ${data?.usage?.extract_mode}`
  )

  // Reducto returns result as an array when extract_mode is "extract"
  const rawResult = data?.result
  const result = Array.isArray(rawResult) ? rawResult[0] : rawResult
  if (!result || !result.document || !Array.isArray(result.products)) {
    throw new Error(
      `Reducto extract response invalid: ${JSON.stringify(data).slice(0, 300)}`
    )
  }

  return {
    document: result.document as ExtractedDocument,
    products: result.products as ExtractedProduct[],
    pageCount: data?.usage?.num_pages ?? 0,
    jobId: data?.job_id ?? '',
    credits: data?.usage?.credits ?? 0,
  }
}

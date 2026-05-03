import type { ExtractedDocument, ExtractedProduct } from './claude-extractor'
import {
  parseReductoChunks,
  type ParseMode,
  type ReductoChunkInput,
} from './reducto-html-parser'
import { coerceDocument, coerceProductArray } from './extract-coerce'
import { detectDocTypeFromFilename, detectDocType } from './prompts'
import { CONTAINER_COLUMN_ORDER } from './column-map'

const REDUCTO_BASE = 'https://platform.reducto.ai'

// ── Timeout config ────────────────────────────────────────────────────────────
// Per-request fetch timeout to Reducto's API (not your host's CPU/RAM).
// Default 12 minutes; override with REDUCTO_PARSE_TIMEOUT_MS / REDUCTO_EXTRACT_TIMEOUT_MS.
const DEFAULT_REDUCTO_TIMEOUT_MS = 12 * 60 * 1000

const REDUCTO_PARSE_TIMEOUT_MS = Number(
  process.env.REDUCTO_PARSE_TIMEOUT_MS ?? DEFAULT_REDUCTO_TIMEOUT_MS
)
const REDUCTO_PARSE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.REDUCTO_PARSE_MAX_ATTEMPTS ?? 2)
)
const REDUCTO_EXTRACT_TIMEOUT_MS = Number(
  process.env.REDUCTO_EXTRACT_TIMEOUT_MS ?? DEFAULT_REDUCTO_TIMEOUT_MS
)
const REDUCTO_EXTRACT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.REDUCTO_EXTRACT_MAX_ATTEMPTS ?? 2)
)

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface ReductoParseOutput extends ReductoExtractResult {
  chunks: ReductoChunkInput[]
}

export function isReductoConfigured(): boolean {
  return Boolean(process.env.REDUCTO_API_KEY)
}

// ── Upload helper (shared between parse and extract paths) ────────────────────

async function uploadFile(
  fileBuffer: Buffer,
  fileName: string,
  apiKey: string,
  tag: string
): Promise<string> {
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
  return file_id as string
}

// ── Fetch with retry helper ───────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxAttempts: number,
  tag: string,
  label: string
): Promise<Response> {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      return res
    } catch (err: any) {
      lastError = err
      const detail =
        err?.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : err?.message ?? String(err)
      console.warn(
        `${tag} ${label} attempt ${attempt}/${maxAttempts} network error: ${detail}`
      )
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 2000))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const msg = (lastError as any)?.message ?? String(lastError)
  throw new Error(`Reducto ${label} network error after ${maxAttempts} attempts: ${msg}`)
}

// ── Parse path (shared between text and HTML-parser paths) ───────────────────

async function parseWithReducto(
  fileBuffer: Buffer,
  fileName: string,
  apiKey: string,
  tag: string
): Promise<ReductoParseOutput> {
  const file_id = await uploadFile(fileBuffer, fileName, apiKey, tag)

  // HTML table format preserves colspan/rowspan — required for MARKS merged cells
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

  const parseRes = await fetchWithRetry(
    `${REDUCTO_BASE}/parse`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: parseBody,
    },
    REDUCTO_PARSE_TIMEOUT_MS,
    REDUCTO_PARSE_MAX_ATTEMPTS,
    tag,
    'parse'
  )

  if (!parseRes.ok) {
    const err = await parseRes.text().catch(() => parseRes.statusText)
    throw new Error(`Reducto parse failed (${parseRes.status}): ${err}`)
  }

  const parsedUnknown = await parseRes.json()
  const parsed = parsedUnknown as Partial<ReductoParseResult> & Record<string, unknown>

  console.log(
    `${tag} parse payload keys: ${Object.keys(parsed).join(', ')}; ` +
    `chunks=${Array.isArray(parsed?.result?.chunks) ? parsed.result!.chunks.length : -1}`
  )

  if (
    !parsed?.result ||
    !Array.isArray(parsed.result.chunks) ||
    !parsed?.usage ||
    !parsed?.job_id
  ) {
    throw new Error(
      `Reducto parse response invalid: ` +
      `has_result=${Boolean(parsed?.result)} ` +
      `has_chunks_array=${Array.isArray(parsed?.result?.chunks)} ` +
      `has_usage=${Boolean(parsed?.usage)} ` +
      `has_job_id=${Boolean(parsed?.job_id)}`
    )
  }

  console.log(
    `${tag} parsed in ${Date.now() - parseStart}ms ` +
    `(api: ${parsed.duration ?? 'n/a'}s) — ` +
    `pages: ${parsed.usage.num_pages} credits: ${parsed.usage.credits}`
  )

  const chunks = parsed.result.chunks as ReductoChunkInput[]
  const text = chunks
    .map(chunk => (typeof chunk?.content === 'string' ? chunk.content : ''))
    .filter(Boolean)
    .join('\n\n')

  return {
    text,
    chunks,
    pageCount: parsed.usage.num_pages,
    jobId: parsed.job_id,
    credits: parsed.usage.credits,
  }
}

export async function extractWithReducto(
  fileBuffer: Buffer,
  fileName: string,
  debugId?: string
): Promise<ReductoExtractResult> {
  const tag = debugId ? `[reducto][${debugId}]` : '[reducto]'
  const apiKey = process.env.REDUCTO_API_KEY
  if (!apiKey) throw new Error('REDUCTO_API_KEY not set')
  const result = await parseWithReducto(fileBuffer, fileName, apiKey, tag)
  return { text: result.text, pageCount: result.pageCount, jobId: result.jobId, credits: result.credits }
}

// ── HTML-parser path (Fix 1) — deterministic, no LLM for column mapping ──────

export async function extractWithReductoHtmlParser(
  fileBuffer: Buffer,
  fileName: string,
  debugId?: string,
  options?: { parseMode?: ParseMode }
): Promise<ReductoStructuredResult> {
  const tag = debugId ? `[reducto-html][${debugId}]` : '[reducto-html]'
  const apiKey = process.env.REDUCTO_API_KEY
  if (!apiKey) throw new Error('REDUCTO_API_KEY not set')

  const parseOutput = await parseWithReducto(fileBuffer, fileName, apiKey, tag)

  const docType =
    detectDocTypeFromFilename(fileName) !== 'unknown'
      ? detectDocTypeFromFilename(fileName)
      : detectDocType(parseOutput.text.split('\n').slice(0, 25))

  const parseMode: ParseMode = options?.parseMode ?? 'inventory'
  const parseResult = parseReductoChunks(parseOutput.chunks, docType, { mode: parseMode })

  console.log(
    `${tag} html_parse done — mode: ${parseMode} tables: ${parseResult.tablesFound} rows: ${parseResult.rowsMapped} doc_type: ${docType}`
  )

  if (parseMode === 'inventory') {
    if (parseResult.tablesFound === 0 || parseResult.rowsMapped === 0) {
      throw new Error(
        `HTML parser found ${parseResult.tablesFound} table(s) and ${parseResult.rowsMapped} product row(s) — insufficient for extraction`
      )
    }
  } else if (parseResult.products.length === 0) {
    throw new Error('Full extraction found no rows')
  }

  return {
    document: parseResult.document,
    products: parseResult.products,
    pageCount: parseOutput.pageCount,
    jobId: parseOutput.jobId,
    credits: parseOutput.credits,
  }
}

// ── Structured extraction schema ──────────────────────────────────────────────
// FIX 1: Added "container_manifest" to document_type enum
// FIX 3: Added default description to section field
// FIX 4: Added accessory sub-row guidance to description fields

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    document: {
      type: 'object',
      properties: {
        doc_number: { type: ['string', 'null'] },
        client_id: { type: ['string', 'null'] },
        container_no: { type: ['string', 'null'] },
        document_date: {
          type: ['string', 'null'],
          description: 'ISO date YYYY-MM-DD or null',
        },
        // FIX 1: container_manifest added — matches Supabase CHECK constraint
        document_type: {
          type: 'string',
          enum: [
            'sales_order',
            'container_manifest',
            'packing_list',
            'invoice',
            'unknown',
          ],
          description:
            'Use "sales_order" if header says 销售单/SALES ORDER. ' +
            'Use "container_manifest" for SANCARGO packing lists that include a CONTAINER NO field. ' +
            'Use "packing_list" for other packing lists without container numbers.',
        },
        footer_totals: {
          type: 'object',
          description:
            'Grand total from the very last summary row of the entire document. ' +
            'Do NOT use per-section yellow subtotal bars.',
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
          description:
            'Payment lines at the bottom of the document. ' +
            'Extract dates exactly as written even if the year appears incorrect (e.g. 2027, 2028 may be typos). ' +
            'Set payment_type to "deposit" for the first payment, "balance" for subsequent ones.',
          items: {
            type: 'object',
            properties: {
              payment_date: {
                type: ['string', 'null'],
                description: 'Extract as written, ISO format YYYY-MM-DD if possible',
              },
              amount_usd: { type: ['number', 'null'] },
              payment_type: {
                type: 'string',
                enum: ['deposit', 'balance', 'freight', 'credit', 'other'],
              },
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
          line_no: {
            type: ['integer', 'null'],
            description: 'Sequential row number from the document (1-indexed)',
          },
          marks: {
            type: ['string', 'null'],
            description:
              'The full product code from the MARKS column, e.g. "MS-311-9 SANCARGO" or "37-T-120-1 SANCARGO". ' +
              'This is the primary product identifier. ' +
              'Propagate down from merged cells to every sub-row that lacks its own value.',
          },
          shop: { type: ['string', 'null'] },
          item_code: {
            type: ['string', 'null'],
            description:
              'The sequential ITEM NO from the document (e.g. 1, 2, 9+20). ' +
              'This is a small number or number range — NOT the marks/code column.',
          },
          description: {
            type: ['string', 'null'],
            description:
              'Product description. For accessory sub-rows (e.g. "accessories 网架", ' +
              '"accessories 玻璃", "accessories 底座") use the accessory text as the description.',
          },
          packaging: { type: ['string', 'null'] },
          qty_per_carton: { type: ['number', 'null'] },
          total_cartons: { type: ['number', 'null'] },
          total_qty: { type: ['number', 'null'] },
          unit_price_rmb: {
            type: ['number', 'null'],
            description:
              'Unit price in RMB. Null for accessory sub-rows — their cost is included in the parent row price.',
          },
          total_amount_rmb: {
            type: ['number', 'null'],
            description:
              'Total amount in RMB. Null for accessory sub-rows — do NOT copy the parent row amount down.',
          },
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
          // FIX 3: Default description added so Reducto doesn't guess
          section: {
            type: 'string',
            enum: ['shipped', 'left_in_warehouse', 'repacked'],
            description:
              'Default to "shipped" for all rows in the main order table. ' +
              'Change to "left_in_warehouse" for rows under a GOODS LEFT IN SANCARGO header. ' +
              'Change to "repacked" for rows under a STUFFED INTO THIS CONTAINER or REPACKED GOODS header.',
          },
          remarks: { type: ['string', 'null'] },
        },
        required: [
          'line_no',
          'marks',
          'item_code',
          'description',
          'total_cartons',
          'total_qty',
          'total_amount_rmb',
          'section',
        ],
      },
    },
  },
  required: ['document', 'products'],
}

// ── System prompt ─────────────────────────────────────────────────────────────
// FIX 2: Repacked detection loosened to match actual PDF text
// FIX 4: Accessory sub-row rules added
// FIX 5: Payment date typo note added

const EXTRACTION_SYSTEM_PROMPT = `
You are extracting structured data from a Chinese packing list, sales order, or container manifest. Read EVERY product row — do not skip any.

SECTION CLASSIFICATION:
- section defaults to "shipped" for all rows in the main order table (labelled NEW ORDER or similar)
- Use "left_in_warehouse" for ALL rows that appear after a section header containing "GOODS LEFT" or "LEFT IN SANCARGO" or "LEFT IN WAREHOUSE" — regardless of exact punctuation or surrounding text
- Use "repacked" for ALL rows that appear after any section header containing the words "STUFFED INTO THIS CONTAINER" or "REPACKED" or "REPACKAGED" — regardless of exact punctuation, capitalisation, or surrounding text (e.g. "37-T-1 18 CTN GOODS STUFFED INTO THIS CONTAINER(REPACKED GOODS)" should trigger this)
- Once a section header is encountered, ALL subsequent rows belong to that section until the next section header
- NEVER assign left_in_warehouse or repacked to rows that appear before those section headers

YELLOW / ORANGE HIGHLIGHTED ROWS (subtotal bars):
- The document contains highlighted rows that show only aggregate numbers (e.g. "400CTNS | 85.144CBM | 12781.7KGS | ¥594,245.00") with NO product code, description, unit dimensions, unit weight, or unit price
- These are SECTION SUBTOTALS — do NOT add them to the products array
- footer_totals should come from the GRAND TOTAL at the very bottom of the entire document, NOT from per-section subtotal bars

COLUMN ORDER (left to right in the product table):
${CONTAINER_COLUMN_ORDER}

CRITICAL COLUMN MAPPING — never swap adjacent numeric columns:
- "MARKS" column → marks field (full code like "MS-311-9 SANCARGO" — always includes SANCARGO or similar suffix)
- "ITEM NO" column → item_code field (sequential number like 1, 2, 3, or range like 9+20)
- "PACKING" / "qty/ctn" → qty_per_carton (pieces per carton box, e.g. 12pcs/ctn → 12)
- "T.CTN" / "CTNS" → total_cartons (number of carton boxes, usually 1–30)
- "TOTAL QTY" → total_qty (total pieces = qty_per_carton × total_cartons)
- "L / W / H" → dim_l_cm, dim_w_cm, dim_h_cm (box dimensions in cm)
- "UNIT CBM" → unit_cbm; "TOTAL CBM" → total_cbm
- "UNIT WEIGHT" → unit_weight_kg; "TOTAL WEIGHT" → total_weight_kg
- "U/P" / "UNIT PRICE" → unit_price_rmb (price per piece); "TOTAL AMOUNT" → total_amount_rmb

MARKS PROPAGATION:
- The MARKS column often spans multiple rows (merged cell) — copy the marks value down to every sub-row that has no marks of its own
- Apply the same section as the parent row to all its sub-rows

ACCESSORY SUB-ROWS:
- Some parent rows have child accessory rows directly below them, identified by descriptions like "accessories 网架", "accessories 玻璃", "accessories 底座", "accessories 盖板", "accessories 底座", "accessories 纸箱"
- These sub-rows intentionally have NO unit_price_rmb and NO total_amount_rmb — their cost is bundled into the parent row price
- Set unit_price_rmb and total_amount_rmb to null for accessory sub-rows — do NOT copy values from the parent
- Do extract total_cartons, total_cbm, total_weight_kg for accessory sub-rows as these are real shipped quantities
- Propagate the parent's marks, section, and shop values down to accessory sub-rows

DOCUMENT TYPE:
- "sales_order" if the header contains 销售单 or SALES ORDER
- "container_manifest" if the header contains CONTAINER NO and CLIENT DETAILS and references SANCARGO
- "packing_list" for other packing lists
- "unknown" if unclear

PAYMENT LINES:
- Extract all payment lines at the bottom of the document
- Extract dates exactly as written — years like 2027 or 2028 may be typos in the original document, extract them anyway
- First payment entry = "deposit", subsequent entries = "balance"

GENERAL RULES:
- All monetary amounts are in RMB (元/¥) unless explicitly labelled USD
- Dimensions in cm; convert from mm if needed (divide by 10)
- Weights in kg
- Return null for any field that cannot be determined
- Do not invent or estimate values — null is always correct for unknown fields
`.trim()

// ── Structured extraction path ────────────────────────────────────────────────

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

  const file_id = await uploadFile(fileBuffer, fileName, apiKey, tag)

  const extractStart = Date.now()
  const extractBody = JSON.stringify({
    input: { file_id },
    instructions: {
      schema: EXTRACTION_SCHEMA,
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
    },
    settings: {
      // deep_extract: better row completeness on complex manifests; slower (large PDFs).
      deep_extract: process.env.REDUCTO_DEEP_EXTRACT === '1',
    },
  })

  const extractRes = await fetchWithRetry(
    `${REDUCTO_BASE}/extract`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: extractBody,
    },
    REDUCTO_EXTRACT_TIMEOUT_MS,
    REDUCTO_EXTRACT_MAX_ATTEMPTS,
    tag,
    'extract'
  )

  if (!extractRes.ok) {
    const errText = await extractRes.text().catch(() => extractRes.statusText)
    throw new Error(`Reducto extract failed (${extractRes.status}): ${errText}`)
  }

  const data = await extractRes.json()
  console.log(
    `${tag} [structured] done in ${Date.now() - extractStart}ms — ` +
    `pages: ${data?.usage?.num_pages} ` +
    `credits: ${data?.usage?.credits} ` +
    `extract_mode: ${data?.usage?.extract_mode}`
  )

  // Reducto returns result as an array when extract_mode is "extract"
  const rawResult = data?.result
  const result = Array.isArray(rawResult) ? rawResult[0] : rawResult

  if (!result || !result.document || !Array.isArray(result.products)) {
    throw new Error(
      `Reducto extract response invalid: ${JSON.stringify(data).slice(0, 300)}`
    )
  }

  // Coerce raw LLM output: fixes string-numbers, null-as-string, missing fields,
  // and invalid section values that Reducto's model occasionally produces.
  const products = coerceProductArray(result.products)
  const document = coerceDocument(result.document)

  return {
    document,
    products,
    pageCount: data?.usage?.num_pages ?? 0,
    jobId: data?.job_id ?? '',
    credits: data?.usage?.credits ?? 0,
  }
}
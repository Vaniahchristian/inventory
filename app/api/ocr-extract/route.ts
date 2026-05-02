import { NextResponse } from 'next/server'
import vision from '@google-cloud/vision'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import { detectDocType } from '@/lib/prompts'
import { extractWithClaudeChunked } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'
import { filterToInventoryProducts } from '@/lib/sections'

export const runtime = 'nodejs'

const KEY_FILE = path.join(process.cwd(), 'rosy-cogency-494512-n2-1755231a72ea.json')

const VISION_PAGE_BATCH = 5
const MAX_PDF_PAGES = 20

// ── Timing helper ──────────────────────────────────────────────────────────────
function makeTimer(label: string) {
  const start = Date.now()
  let last = start
  return {
    step(msg: string) {
      const now = Date.now()
      const stepMs = now - last
      const totalMs = now - start
      console.log(`[${label}] +${stepMs}ms (${totalMs}ms total) — ${msg}`)
      last = now
    },
    total() {
      return Date.now() - start
    },
  }
}

let visionClient: InstanceType<typeof vision.ImageAnnotatorClient> | null = null

function getVisionClient(): InstanceType<typeof vision.ImageAnnotatorClient> {
  if (visionClient) return visionClient

  const inlineCreds = process.env.GCP_VISION_CREDENTIALS_JSON
  if (inlineCreds) {
    try {
      const creds = JSON.parse(inlineCreds)
      visionClient = new vision.ImageAnnotatorClient({ credentials: creds })
      console.log('[route] Vision client initialised from GCP_VISION_CREDENTIALS_JSON')
      return visionClient
    } catch {
      throw new Error('Invalid GCP_VISION_CREDENTIALS_JSON format')
    }
  }

  if (fs.existsSync(KEY_FILE)) {
    visionClient = new vision.ImageAnnotatorClient({ keyFilename: KEY_FILE })
    console.log('[route] Vision client initialised from key file')
    return visionClient
  }

  throw new Error(
    'Google Vision credentials not configured. Set GCP_VISION_CREDENTIALS_JSON in Vercel env.'
  )
}

async function runOCR(content: Buffer, isPdf: boolean, timer: ReturnType<typeof makeTimer>): Promise<string[]> {
  const client = getVisionClient()
  const lines: string[] = []

  timer.step(`OCR start — isPdf=${isPdf} bytes=${content.length}`)

  if (isPdf) {
    const batches: number[][] = []
    for (let start = 1; start <= MAX_PDF_PAGES; start += VISION_PAGE_BATCH) {
      batches.push(Array.from({ length: VISION_PAGE_BATCH }, (_, i) => start + i))
    }

    console.log(`[ocr] will attempt ${batches.length} page batch(es) of ${VISION_PAGE_BATCH}`)

    for (const pageBatch of batches) {
      const batchLabel = `pages ${pageBatch[0]}–${pageBatch[pageBatch.length - 1]}`
      console.log(`[ocr] → requesting ${batchLabel}`)
      const batchStart = Date.now()

      try {
        const [batchResult] = await client.batchAnnotateFiles({
          requests: [{
            inputConfig: { content, mimeType: 'application/pdf' },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            pages: pageBatch,
          }],
        })

        const batchMs = Date.now() - batchStart
        const pageResponses = (batchResult.responses?.[0] as any)?.responses ?? []
        console.log(`[ocr] ← ${batchLabel} returned ${pageResponses.length} page(s) in ${batchMs}ms`)

        if (pageResponses.length === 0) {
          console.log('[ocr] no pages returned — document end reached')
          break
        }

        let batchLines = 0
        for (const pageResp of pageResponses) {
          const text: string = pageResp.fullTextAnnotation?.text ?? ''
          if (text) {
            const pageLines = text.split('\n').filter(Boolean)
            lines.push(...pageLines)
            batchLines += pageLines.length
          }
        }
        console.log(`[ocr] ${batchLabel} extracted ${batchLines} lines (running total: ${lines.length})`)

        if (pageResponses.length < VISION_PAGE_BATCH) {
          console.log('[ocr] fewer pages returned than requested — reached document end')
          break
        }
      } catch (err: any) {
        if (err?.message?.includes('INVALID_ARGUMENT') || err?.code === 3) {
          console.log(`[ocr] ${batchLabel} beyond document end (INVALID_ARGUMENT) — stopping`)
          break
        }
        console.error(`[ocr] ${batchLabel} error: ${err?.message ?? err}`)
        throw err
      }
    }
  } else {
    console.log('[ocr] → single image annotate')
    const imgStart = Date.now()
    const [result] = await client.annotateImage({
      image: { content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    })
    const text: string = result.fullTextAnnotation?.text ?? ''
    lines.push(...text.split('\n').filter(Boolean))
    console.log(`[ocr] ← image annotate done in ${Date.now() - imgStart}ms, ${lines.length} lines`)
  }

  timer.step(`OCR complete — total_lines=${lines.length}`)
  return lines
}

export async function POST(req: Request) {
  const timer = makeTimer('route')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('[route] ▶ POST /api/ocr-extract')

  try {
    const contentType = req.headers.get('content-type') ?? ''
    let fileName: string
    let skipInsert: boolean
    let content: Buffer

    console.log(`[route] content-type: ${contentType}`)

    if (contentType.includes('application/json')) {
      const body = await req.json()
      const blobUrl: string = body.blob_url
      fileName = body.file_name ?? 'upload.pdf'
      skipInsert = body.skip_insert === true

      console.log(`[route] blob path — file_name=${fileName} skip_insert=${skipInsert}`)
      console.log(`[route] blob_url=${blobUrl}`)

      if (!blobUrl) {
        return NextResponse.json({ error: 'Missing blob_url' }, { status: 400 })
      }

      timer.step('blob download start')
      const blobRes = await fetch(blobUrl)
      if (!blobRes.ok) {
        console.error(`[route] blob download failed: HTTP ${blobRes.status}`)
        return NextResponse.json(
          { error: `Failed to download blob (HTTP ${blobRes.status})` },
          { status: 502 }
        )
      }
      content = Buffer.from(await blobRes.arrayBuffer())
      timer.step(`blob download complete — bytes=${content.length}`)
    } else {
      const form = await req.formData()
      const file = form.get('file')
      skipInsert = form.get('skip_insert') === 'true'

      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Missing file' }, { status: 400 })
      }
      fileName = file.name
      timer.step('direct upload — reading arrayBuffer')
      content = Buffer.from(await file.arrayBuffer())
      timer.step(`direct upload complete — bytes=${content.length}`)
    }

    const name = fileName.toLowerCase()
    const isPdf = name.endsWith('.pdf')
    const isImage = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')

    console.log(`[route] file=${fileName} isPdf=${isPdf} isImage=${isImage} bytes=${content.length}`)

    if (!isPdf && !isImage) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    const fileSha256 = crypto.createHash('sha256').update(content).digest('hex')
    console.log(`[route] sha256=${fileSha256}`)

    // ── Step 1: OCR ───────────────────────────────────────────────────────────
    console.log('[route] ── STEP 1: Google Vision OCR ──')
    const lines = await runOCR(content, isPdf, timer)

    if (lines.length === 0) {
      console.error('[route] OCR returned 0 lines')
      return NextResponse.json({ error: 'OCR returned no text' }, { status: 422 })
    }

    console.log(`[route] OCR lines sample (first 5):`)
    lines.slice(0, 5).forEach((l, i) => console.log(`  [${i}] ${l.slice(0, 120)}`))

    // ── Step 2: Detect doc type ───────────────────────────────────────────────
    const docType = detectDocType(lines)
    console.log(`[route] ── STEP 2: doc_type=${docType}`)
    console.log(`[route] detection header (first 25 lines): ${lines.slice(0, 25).join(' ').slice(0, 300)}`)

    // ── Step 3: Claude extraction ─────────────────────────────────────────────
    console.log('[route] ── STEP 3: Claude chunked extraction ──')
    timer.step('Claude extraction start')
    const extraction = await extractWithClaudeChunked(lines, docType)
    timer.step(`Claude extraction complete — rows=${extraction.products.length} chunks=${extraction.chunking.chunk_count}`)

    console.log('[route] chunking stats:', JSON.stringify(extraction.chunking))
    console.log(`[route] input_tokens=${extraction.input_tokens} output_tokens=${extraction.output_tokens}`)
    console.log(`[route] truncated=${extraction.truncated}`)

    if (extraction.products.length === 0) {
      console.error('[route] Claude returned 0 product rows')
      return NextResponse.json({ error: 'Claude extracted 0 rows' }, { status: 422 })
    }

    console.log(`[route] first 3 extracted products:`)
    extraction.products.slice(0, 3).forEach((p, i) =>
      console.log(`  [${i}] line_no=${p.line_no} item_code=${p.item_code} marks=${p.marks} desc=${String(p.description ?? '').slice(0, 60)}`)
    )

    // ── Step 4: Validate ──────────────────────────────────────────────────────
    console.log('[route] ── STEP 4: Validation ──')
    timer.step('validation start')
    const inventoryProducts = filterToInventoryProducts(extraction.products)
    if (inventoryProducts.length === 0) {
      console.error('[route] all rows were in non-inventory sections')
      return NextResponse.json(
        { error: 'No shippable rows after excluding warehouse and repacked sections' },
        { status: 422 }
      )
    }

    const validation = validateExtraction(extraction.document, inventoryProducts)
    timer.step(`validation complete — totals_match=${validation.totals_match} flags=${validation.validation_flags.length}`)

    if (validation.validation_flags.length > 0) {
      console.warn('[route] validation flags:', validation.validation_flags)
    }

    // ── Step 5: Supabase insert ───────────────────────────────────────────────
    let insertResult = null
    if (!skipInsert) {
      console.log('[route] ── STEP 5: Supabase insert ──')
      timer.step('Supabase insert start')
      insertResult = await insertToSupabase(fileName, fileSha256, extraction, lines)
      timer.step(`Supabase insert complete — document_id=${insertResult.document_id} items=${insertResult.items_inserted}`)
    } else {
      console.log('[route] ── STEP 5: Supabase insert SKIPPED (skip_insert=true) ──')
    }

    const totalMs = timer.total()
    console.log(`[route] ✓ done in ${totalMs}ms`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    const extractionForClient = { ...extraction, products: inventoryProducts }

    return NextResponse.json({
      success: true,
      document_id: insertResult?.document_id ?? null,
      doc_type: docType,
      rows_extracted: inventoryProducts.length,
      rows_pass: validation.pass_count,
      rows_flagged: validation.flag_count,
      totals_match: validation.totals_match,
      totals_diff: validation.totals_diff,
      validation_flags: validation.validation_flags,
      truncated: extraction.truncated,
      metrics: {
        ocr_lines: lines.length,
        input_tokens: extraction.input_tokens,
        output_tokens: extraction.output_tokens,
        chunk_count: extraction.chunking.chunk_count,
        subchunk_count: extraction.chunking.subchunk_count,
        failed_chunks: extraction.chunking.failed_chunks,
        truncated_chunks: extraction.chunking.truncated_chunks,
        duration_ms: totalMs,
      },
      chunking: extraction.chunking,
      products: extractionForClient.products,
      document: extraction.document,
      lines,
    })
  } catch (err: any) {
    const totalMs = timer.total()
    console.error(`[route] ✗ error after ${totalMs}ms: ${err?.message ?? err}`)
    if (err?.stack) console.error('[route] stack:', err.stack)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    return NextResponse.json(
      { error: err?.message ?? 'Extraction failed', success: false },
      { status: 500 }
    )
  }
}

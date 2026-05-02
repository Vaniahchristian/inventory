import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { detectDocTypeFromFilename, detectDocType } from '@/lib/prompts'
import { extractWithClaudeChunked, type ClaudeExtractionResult } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'
import { extractStructuredWithReducto, isReductoConfigured } from '@/lib/reducto-client'
import { filterToInventoryProducts } from '@/lib/sections'

export const runtime = 'nodejs'
export const maxDuration = 420

function selectRelevantExtractionLines(input: string[]): string[] {
  const lines = input.map(l => l.trim()).filter(Boolean)
  const keep = lines.filter((line) => {
    const u = line.toUpperCase()
    return (
      /^\d+\s+/.test(line) ||
      /[¥￥]\s*[\d,]/.test(line) ||
      /\b(CTN|CTNS|PCS|CBM|KGS|U\/P|AMOUNT|PACKING|ITEM NO|ORD NO|CUS NO|W\.H\.)\b/i.test(line) ||
      /[一-鿿]/.test(line) ||
      u.includes('TOTAL') ||
      u.includes('SALES') ||
      u.includes('WAREHOUSE') ||
      u.includes('SANCARGO')
    )
  })
  const maxLines = Math.max(200, Number(process.env.EXTRACT_MAX_LINES ?? 1200))
  return keep.slice(0, maxLines)
}

function buildResponse(
  extraction: ClaudeExtractionResult,
  extractionMethod: string,
  documentId: string | null,
  validation: ReturnType<typeof validateExtraction>,
  startMs: number,
  linesRaw = 0,
  linesUsed = 0,
  chunkCount = 1,
  failedChunks = 0,
  truncatedChunks = 0,
) {
  const durationMs = Date.now() - startMs
  return NextResponse.json({
    success: true,
    document_id: documentId,
    doc_type: extraction.document.document_type,
    extraction_method: extractionMethod,
    rows_extracted: extraction.products.length,
    rows_pass: validation.pass_count,
    rows_flagged: validation.flag_count,
    totals_match: validation.totals_match,
    totals_diff: validation.totals_diff,
    products: extraction.products,
    document: extraction.document,
    validation_flags: validation.validation_flags,
    metrics: {
      duration_ms: durationMs,
      input_tokens: extraction.input_tokens,
      output_tokens: extraction.output_tokens,
      lines_raw: linesRaw,
      lines_used: linesUsed,
      chunk_count: chunkCount,
      failed_chunks: failedChunks,
      truncated_chunks: truncatedChunks,
    },
  })
}

export async function POST(req: Request) {
  const startMs = Date.now()
  const debugId = crypto.randomUUID().slice(0, 8)
  const contentType = req.headers.get('content-type') ?? ''

  let text = ''
  let fileName = 'document.pdf'
  let skipInsert = false
  let fallbackText = ''

  if (contentType.includes('multipart/form-data')) {
    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
    }

    fileName = String(formData.get('file_name') ?? formData.get('fileName') ?? 'document.pdf')
    skipInsert = formData.get('skip_db_insert') === 'true'
    fallbackText = String(formData.get('fallback_text') ?? '')
    const file = formData.get('file') as File | null

    // ── PRIMARY PATH: Reducto structured extract — no Claude needed ────────────
    // Reducto /extract with schema returns typed JSON directly. Total time: ~15-30s.
    // Falls back to Claude text path if Reducto fails.
    if (isReductoConfigured() && file) {
      try {
        console.log(`[extract][${debugId}] reducto_extract — file: ${fileName} size: ${file.size}`)
        const buffer = Buffer.from(await file.arrayBuffer())
        const structured = await extractStructuredWithReducto(buffer, fileName, debugId)

        if (structured.products.length === 0) {
          return NextResponse.json({ error: 'Reducto extracted 0 rows' }, { status: 422 })
        }

        const extraction: ClaudeExtractionResult = {
          document: structured.document,
          products: structured.products,
          model: 'reducto',
          input_tokens: 0,
          output_tokens: 0,
          truncated: false,
        }

        const inventoryProducts = filterToInventoryProducts(structured.products)
        if (inventoryProducts.length === 0) {
          return NextResponse.json(
            { error: 'No shippable rows after excluding GOODS LEFT IN SANCARGO and REPACKED GOODS sections' },
            { status: 422 }
          )
        }

        const validation = validateExtraction(extraction.document, inventoryProducts)
        const extractionForClient: ClaudeExtractionResult = { ...extraction, products: inventoryProducts }
        let documentId: string | null = null
        if (!skipInsert) {
          try {
            const fileSha256 = crypto.createHash('sha256').update(fallbackText || fileName).digest('hex')
            const result = await insertToSupabase(fileName, fileSha256, extraction, [])
            documentId = result.document_id
          } catch (err: any) {
            console.error(`[extract][${debugId}] DB insert failed: ${err?.message ?? err}`)
          }
        }

        const durationMs = Date.now() - startMs
        console.log(`[extract][${debugId}] reducto_extract complete in ${durationMs}ms — rows: ${structured.products.length} pages: ${structured.pageCount} credits: ${structured.credits}`)

        return buildResponse(extractionForClient, 'reducto_extract', documentId, validation, startMs)
      } catch (err: any) {
        console.warn(`[extract][${debugId}] Reducto structured extract failed — ${err?.message ?? err}; falling back to pdfjs + Claude`)
        text = fallbackText
      }
    } else {
      text = fallbackText
    }

  // ── JSON path (browser sends pre-extracted text) ───────────────────────────
  } else {
    try {
      const body = await req.json()
      text = body.text ?? ''
      fileName = body.file_name ?? body.fileName ?? 'document.pdf'
      skipInsert = Boolean(body.skip_db_insert)
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
  }

  // ── FALLBACK PATH: pdfjs text → Claude chunked extraction ─────────────────
  if (!text || text.trim().length < 10) {
    return NextResponse.json({ error: 'No text content to extract from' }, { status: 400 })
  }

  const linesRaw = text.split('\n').map(l => l.trim()).filter(Boolean)
  const lines = selectRelevantExtractionLines(linesRaw)
  const docType = detectDocTypeFromFilename(fileName) !== 'unknown'
    ? detectDocTypeFromFilename(fileName)
    : detectDocType(lines)

  console.log(`[extract][${debugId}] claude_text — doc_type: ${docType} lines_raw: ${linesRaw.length} lines_used: ${lines.length}`)

  let extraction: Awaited<ReturnType<typeof extractWithClaudeChunked>>
  try {
    extraction = await extractWithClaudeChunked(lines, docType)
    console.log(
      `[extract][${debugId}] chunking: chunks=${extraction.chunking.chunk_count} subchunks=${extraction.chunking.subchunk_count} failed=${extraction.chunking.failed_chunks} truncated=${extraction.chunking.truncated_chunks}`
    )
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error(`[extract][${debugId}] Claude call failed: ${msg}`)
    if (err?.error) console.error(`[extract][${debugId}] api_error: ${JSON.stringify(err.error)}`)
    return NextResponse.json({ error: `Extraction failed: ${msg}` }, { status: 502 })
  }

  if (extraction.products.length === 0) {
    return NextResponse.json(
      { error: 'Extracted 0 rows — check that the PDF contains readable text' },
      { status: 422 }
    )
  }

  const inventoryProducts = filterToInventoryProducts(extraction.products)
  if (inventoryProducts.length === 0) {
    return NextResponse.json(
      { error: 'No shippable rows after excluding GOODS LEFT IN SANCARGO and REPACKED GOODS sections' },
      { status: 422 }
    )
  }

  const validation = validateExtraction(extraction.document, inventoryProducts)
  const extractionForClient: ClaudeExtractionResult = { ...extraction, products: inventoryProducts }

  let documentId: string | null = null
  if (!skipInsert) {
    try {
      const fileSha256 = crypto.createHash('sha256').update(text).digest('hex')
      const result = await insertToSupabase(fileName, fileSha256, extraction, lines)
      documentId = result.document_id
    } catch (err: any) {
      console.error(`[extract][${debugId}] DB insert failed: ${err?.message ?? err}`)
    }
  }

  const durationMs = Date.now() - startMs
  console.log(
    `[extract][${debugId}] claude_text complete in ${durationMs}ms — rows: ${extraction.products.length} tokens_in: ${extraction.input_tokens} tokens_out: ${extraction.output_tokens}`
  )

  return buildResponse(
    extractionForClient,
    isReductoConfigured() ? 'reducto_fallback_claude' : 'claude_text',
    documentId,
    validation,
    startMs,
    linesRaw.length,
    lines.length,
    extraction.chunking.chunk_count,
    extraction.chunking.failed_chunks,
    extraction.chunking.truncated_chunks,
  )
}

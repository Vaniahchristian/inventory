import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { detectDocTypeFromFilename, detectDocType } from '@/lib/prompts'
import { extractWithClaudeChunked, type ClaudeExtractionResult } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'
import { extractStructuredWithReducto, extractWithReductoHtmlParser, isReductoConfigured } from '@/lib/reducto-client'
import { isFullExtractBanner } from '@/lib/full-extract'
import { filterToInventoryProducts, dropTotalRows } from '@/lib/sections'
import type { ValidationResult } from '@/lib/validator'

export const runtime = 'nodejs'
// Must cover Reducto client timeout (default 12m) + upload + JSON; see lib/reducto-client.ts
export const maxDuration = 900

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
  validation: ValidationResult,
  startMs: number,
  linesRaw = 0,
  linesUsed = 0,
  chunkCount = 1,
  failedChunks = 0,
  truncatedChunks = 0,
  responseOpts?: { full_extract?: boolean }
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
    full_extract: responseOpts?.full_extract ?? false,
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
    const fullExtract = formData.get('full_extract') === 'true'
    fallbackText = String(formData.get('fallback_text') ?? '')
    const file = formData.get('file') as File | null

    // ── PRIMARY PATH: Reducto /parse + deterministic HTML column parser ────────
    // Fix 1: No LLM involved in column mapping — always returns same result.
    // Falls back to Reducto /extract (LLM schema) then to pdfjs+Claude.
    if (isReductoConfigured() && file) {
      let buffer: Buffer
      try {
        buffer = Buffer.from(await file.arrayBuffer())
      } catch {
        return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 })
      }

      let structured: Awaited<ReturnType<typeof extractWithReductoHtmlParser>> | null = null
      let extractionMethod = 'reducto_html_parse'

      // Try 1: deterministic HTML parser
      try {
        console.log(
          `[extract][${debugId}] reducto_html_parse — file: ${fileName} size: ${file.size} full_extract: ${fullExtract}`
        )
        structured = await extractWithReductoHtmlParser(buffer, fileName, debugId, {
          parseMode: fullExtract ? 'full' : 'inventory',
        })
      } catch (htmlErr: any) {
        console.warn(`[extract][${debugId}] HTML parser failed (${htmlErr?.message ?? htmlErr}) — trying schema extract`)
        // Try 2: Reducto /extract with LLM schema (original approach)
        try {
          structured = await extractStructuredWithReducto(buffer, fileName, debugId)
          extractionMethod = 'reducto_extract'
        } catch (schemaErr: any) {
          console.warn(`[extract][${debugId}] Schema extract also failed (${schemaErr?.message ?? schemaErr}) — falling back to Claude`)
          text = fallbackText
        }
      }

      if (structured && structured.products.length > 0) {
        const extraction: ClaudeExtractionResult = {
          document: structured.document,
          products: structured.products,
          model: extractionMethod,
          input_tokens: 0,
          output_tokens: 0,
          truncated: false,
        }

        const forInventorySource = structured.products.filter(p => !isFullExtractBanner(p))
        const inventoryProducts = dropTotalRows(filterToInventoryProducts(forInventorySource))

        if (!fullExtract && inventoryProducts.length === 0) {
          return NextResponse.json(
            { error: 'No shippable rows after excluding GOODS LEFT IN SANCARGO and REPACKED GOODS sections' },
            { status: 422 }
          )
        }

        const validation: ValidationResult = fullExtract
          ? {
              totals_match: true,
              totals_diff: {},
              validation_flags: ['full_extract: footer checksums skipped — delete heading rows before save if needed'],
              row_results: [],
              pass_count: inventoryProducts.length,
              flag_count: 0,
            }
          : validateExtraction(extraction.document, inventoryProducts, forInventorySource)

        const extractionForClient: ClaudeExtractionResult = fullExtract
          ? extraction
          : { ...extraction, products: inventoryProducts }

        let documentId: string | null = null
        if (!skipInsert) {
          try {
            // Must hash file bytes — filename-only caused same hash for any PDF with that name,
            // breaking replace logic and double-counting aggregates on re-upload with renamed files.
            const fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex')
            const result = await insertToSupabase(fileName, fileSha256, extraction, [], structured.sectionSubtotals)
            documentId = result.document_id
          } catch (err: any) {
            console.error(`[extract][${debugId}] DB insert failed: ${err?.message ?? err}`)
          }
        }

        const durationMs = Date.now() - startMs
        console.log(`[extract][${debugId}] ${extractionMethod} complete in ${durationMs}ms — rows: ${structured.products.length} pages: ${structured.pageCount} credits: ${structured.credits}`)

        return buildResponse(
          extractionForClient,
          extractionMethod,
          documentId,
          validation,
          startMs,
          0,
          0,
          1,
          0,
          0,
          { full_extract: fullExtract }
        )
      } else if (structured && structured.products.length === 0) {
        return NextResponse.json({ error: 'Reducto extracted 0 rows' }, { status: 422 })
      }
      // else: text was set to fallbackText above, fall through to Claude path
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
  const textDocType = detectDocType(lines)
  const fileDocType = detectDocTypeFromFilename(fileName)
  const docType = textDocType !== 'unknown'
    ? textDocType
    : (fileDocType !== 'unknown' ? fileDocType : 'container_manifest')

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

  const inventoryProducts = dropTotalRows(filterToInventoryProducts(extraction.products))
  if (inventoryProducts.length === 0) {
    return NextResponse.json(
      { error: 'No shippable rows after excluding GOODS LEFT IN SANCARGO and REPACKED GOODS sections' },
      { status: 422 }
    )
  }

  const validation = validateExtraction(extraction.document, inventoryProducts, extraction.products)
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

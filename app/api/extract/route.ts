import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { detectDocTypeFromFilename, detectDocType } from '@/lib/prompts'
import { extractWithClaudeChunked } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'
import { extractWithReducto, isReductoConfigured } from '@/lib/reducto-client'

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
      /[\u4e00-\u9fff]/.test(line) ||
      u.includes('TOTAL') ||
      u.includes('SALES') ||
      u.includes('WAREHOUSE') ||
      u.includes('SANCARGO')
    )
  })
  const maxLines = Math.max(200, Number(process.env.EXTRACT_MAX_LINES ?? 1200))
  return keep.slice(0, maxLines)
}

export async function POST(req: Request) {
  const startMs = Date.now()
  const debugId = crypto.randomUUID().slice(0, 8)
  const contentType = req.headers.get('content-type') ?? ''

  let text = ''
  let fileName = 'document.pdf'
  let skipInsert = false
  let extractionMethod = 'claude_text'

  // ── Multipart (primary path: browser sends the actual PDF file) ─────────────
  if (contentType.includes('multipart/form-data')) {
    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
    }

    fileName = String(formData.get('file_name') ?? formData.get('fileName') ?? 'document.pdf')
    skipInsert = formData.get('skip_db_insert') === 'true'
    const fallbackText = String(formData.get('fallback_text') ?? '')
    const file = formData.get('file') as File | null

    if (isReductoConfigured() && file) {
      try {
        console.log(
          `[extract][${debugId}] Reducto path — file: ${fileName} size: ${file.size} key_present=${Boolean(process.env.REDUCTO_API_KEY)}`
        )
        const buffer = Buffer.from(await file.arrayBuffer())
        const reductoResult = await extractWithReducto(buffer, fileName, debugId)
        text = reductoResult.text
        extractionMethod = 'reducto'
        console.log(
          `[extract][${debugId}] Reducto done — chars: ${text.length} pages: ${reductoResult.pageCount} credits: ${reductoResult.credits} job_id=${reductoResult.jobId}`
        )
      } catch (reductoErr: any) {
        const fullErr = JSON.stringify(
          reductoErr,
          Object.getOwnPropertyNames(reductoErr ?? {}),
          2
        )
        console.warn(
          `[extract][${debugId}] Reducto failed, falling back to pdfjs text — ${reductoErr?.name ?? 'Error'}: ${reductoErr?.message ?? reductoErr}`
        )
        if (reductoErr?.stack) console.warn(`[extract][${debugId}] Reducto stack: ${reductoErr.stack}`)
        console.warn(`[extract][${debugId}] Reducto error object: ${fullErr}`)
        text = fallbackText
        extractionMethod = 'claude_text_fallback'
      }
    } else {
      // Reducto not configured — use the pdfjs-extracted text the browser sent
      text = fallbackText
      extractionMethod = 'claude_text'
    }

  // ── JSON (fallback: browser sends pre-extracted text) ──────────────────────
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

  if (!text || text.trim().length < 10) {
    return NextResponse.json({ error: 'No text content to extract from' }, { status: 400 })
  }

  const linesRaw = text.split('\n').map(l => l.trim()).filter(Boolean)
  const lines = selectRelevantExtractionLines(linesRaw)
  const docType = detectDocTypeFromFilename(fileName) !== 'unknown'
    ? detectDocTypeFromFilename(fileName)
    : detectDocType(lines)

  console.log(`[extract][${debugId}] method: ${extractionMethod} doc_type: ${docType} lines_raw: ${linesRaw.length} lines_used: ${lines.length}`)

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

  const validation = validateExtraction(extraction.document, extraction.products)

  let documentId: string | null = null
  if (!skipInsert) {
    try {
      const fileSha256 = crypto.createHash('sha256').update(text).digest('hex')
      const result = await insertToSupabase(fileName, fileSha256, extraction, validation, lines)
      documentId = result.document_id
    } catch (err: any) {
      console.error(`[extract][${debugId}] DB insert failed: ${err?.message ?? err}`)
    }
  }

  const durationMs = Date.now() - startMs
  console.log(
    `[extract][${debugId}] complete in ${durationMs}ms — rows: ${extraction.products.length} tokens_in: ${extraction.input_tokens} tokens_out: ${extraction.output_tokens} stop_truncated=${extraction.truncated}`
  )

  return NextResponse.json({
    success: true,
    document_id: documentId,
    doc_type: docType,
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
      lines_raw: linesRaw.length,
      lines_used: lines.length,
      chunk_count: extraction.chunking.chunk_count,
      failed_chunks: extraction.chunking.failed_chunks,
      truncated_chunks: extraction.chunking.truncated_chunks,
    },
  })
}

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { detectDocTypeFromFilename, detectDocType } from '@/lib/prompts'
import { extractWithClaude } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request) {
  const startMs = Date.now()

  let text: string
  let fileName: string
  let skipInsert: boolean

  try {
    const body = await req.json()
    text = body.text
    fileName = body.file_name ?? body.fileName ?? 'document.pdf'
    skipInsert = Boolean(body.skip_db_insert)
    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return NextResponse.json({ error: 'No text content provided' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const docType = detectDocTypeFromFilename(fileName) !== 'unknown'
    ? detectDocTypeFromFilename(fileName)
    : detectDocType(lines)

  console.log(`[extract] file: ${fileName} doc_type: ${docType} lines: ${lines.length}`)

  let extraction: Awaited<ReturnType<typeof extractWithClaude>>
  try {
    extraction = await extractWithClaude(lines, docType, 'extract-route')
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error(`[extract] Claude call failed: ${msg}`)
    if (err?.error) console.error(`[extract] api_error: ${JSON.stringify(err.error)}`)
    return NextResponse.json({ error: `Extraction failed: ${msg}` }, { status: 502 })
  }

  if (extraction.products.length === 0) {
    return NextResponse.json({ error: 'Claude extracted 0 rows — check the PDF text is readable' }, { status: 422 })
  }

  const validation = validateExtraction(extraction.document, extraction.products)

  let documentId: string | null = null
  if (!skipInsert) {
    try {
      const fileSha256 = crypto.createHash('sha256').update(text).digest('hex')
      const result = await insertToSupabase(fileName, fileSha256, extraction, validation, lines)
      documentId = result.document_id
    } catch (err: any) {
      console.error(`[extract] DB insert failed: ${err?.message ?? err}`)
      // Return results even if insert fails — caller can retry save separately
    }
  }

  const durationMs = Date.now() - startMs
  console.log(`[extract] done in ${durationMs}ms — rows: ${extraction.products.length} tokens_in: ${extraction.input_tokens} tokens_out: ${extraction.output_tokens}`)

  return NextResponse.json({
    success: true,
    document_id: documentId,
    doc_type: docType,
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
      lines: lines.length,
    },
  })
}

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabase } from '@/lib/supabase'
import { detectDocTypeFromFilename } from '@/lib/prompts'
import { extractFromBuffer } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'

export const runtime = 'nodejs'
export const maxDuration = 300

// ── Progress helper ────────────────────────────────────────────────────────────
async function setStep(jobId: string, step: string, pct: number, extra?: Record<string, unknown>) {
  console.log(`[process-import] [${jobId}] ${step} (${pct}%)`)
  await supabase
    .from('import_jobs')
    .update({ step, progress_pct: pct, status: 'processing', ...extra })
    .eq('id', jobId)
}

async function failJob(jobId: string, message: string) {
  console.error(`[process-import] [${jobId}] FAILED: ${message}`)
  await supabase
    .from('import_jobs')
    .update({ status: 'failed', step: 'failed', error: message })
    .eq('id', jobId)
}

/**
 * POST /api/process-import
 * Body: { job_id }
 *
 * Intended to be called fire-and-forget from the client after receiving a job_id
 * from /api/queue-import. Writes progress into import_jobs so clients subscribed
 * via Supabase Realtime see live updates without polling.
 *
 * Pipeline (no Google Vision OCR):
 *   download → Claude native PDF extraction → validate → Supabase insert
 */
export async function POST(req: Request) {
  const startMs = Date.now()
  let jobId = ''

  try {
    const body = await req.json()
    jobId = body.job_id

    if (!jobId) {
      return NextResponse.json({ error: 'Missing job_id' }, { status: 400 })
    }

    // Load job
    const { data: job, error: jobErr } = await supabase
      .from('import_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status === 'completed') {
      console.log(`[process-import] [${jobId}] already completed, skipping`)
      return NextResponse.json({ status: 'already_completed' })
    }

    const { file_url: fileUrl, file_name: fileName, skip_db_insert: skipInsert } = job

    // ── Step 1: Download file ──────────────────────────────────────────────────
    await setStep(jobId, 'downloading', 5)
    console.log(`[process-import] [${jobId}] downloading: ${fileUrl}`)

    const fileRes = await fetch(fileUrl)
    if (!fileRes.ok) {
      await failJob(jobId, `Failed to download file: HTTP ${fileRes.status}`)
      return NextResponse.json({ error: 'Download failed' }, { status: 502 })
    }

    const content = Buffer.from(await fileRes.arrayBuffer())
    const fileSha256 = crypto.createHash('sha256').update(content).digest('hex')

    console.log(`[process-import] [${jobId}] downloaded ${content.length} bytes`)
    await setStep(jobId, 'downloading', 15, { progress_pct: 15 })

    // ── Step 2: Detect file type ───────────────────────────────────────────────
    const nameLower = fileName.toLowerCase()
    const isPdf = nameLower.endsWith('.pdf')
    const isImage = nameLower.endsWith('.png') || nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg')

    if (!isPdf && !isImage) {
      await failJob(jobId, `Unsupported file type: ${fileName}`)
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    const mediaType = isPdf ? 'application/pdf'
      : nameLower.endsWith('.png') ? 'image/png'
      : 'image/jpeg'

    // Detect doc type from filename (Claude will also confirm in its response)
    const docTypeHint = detectDocTypeFromFilename(fileName)
    console.log(`[process-import] [${jobId}] media=${mediaType} docTypeHint=${docTypeHint}`)

    // ── Step 3: Claude extraction (no OCR — Claude reads PDF/image natively) ───
    await setStep(jobId, 'extracting', 20)
    console.log(`[process-import] [${jobId}] sending to Claude (native PDF vision)...`)

    const extraction = await extractFromBuffer(content, mediaType, docTypeHint)
    const extractMs = Date.now() - startMs

    console.log(`[process-import] [${jobId}] Claude done in ${extractMs}ms — rows=${extraction.products.length} tokens_in=${extraction.input_tokens} tokens_out=${extraction.output_tokens}`)

    if (extraction.products.length === 0) {
      await failJob(jobId, 'Claude extracted 0 rows — check the PDF is text-readable')
      return NextResponse.json({ error: 'No rows extracted' }, { status: 422 })
    }

    await setStep(jobId, 'validating', 80)

    // ── Step 4: Validate ───────────────────────────────────────────────────────
    const validation = validateExtraction(extraction.document, extraction.products)
    console.log(`[process-import] [${jobId}] validation totals_match=${validation.totals_match} flags=${validation.validation_flags.length}`)

    // ── Step 5: Supabase insert ────────────────────────────────────────────────
    let documentId: string | null = null
    if (!skipInsert) {
      await setStep(jobId, 'saving', 88)
      const insertResult = await insertToSupabase(fileName, fileSha256, extraction, validation, [])
      documentId = insertResult.document_id
      console.log(`[process-import] [${jobId}] saved document_id=${documentId} items=${insertResult.items_inserted}`)
    }

    // ── Done ───────────────────────────────────────────────────────────────────
    const totalMs = Date.now() - startMs
    console.log(`[process-import] [${jobId}] ✓ completed in ${totalMs}ms`)

    await supabase.from('import_jobs').update({
      status: 'completed',
      step: 'done',
      progress_pct: 100,
      doc_type: extraction.document.document_type,
      rows_extracted: extraction.products.length,
      rows_pass: validation.pass_count,
      rows_flagged: validation.flag_count,
      totals_match: validation.totals_match,
      document_id: documentId,
      result: {
        products: extraction.products,
        document: extraction.document,
        validation_flags: validation.validation_flags,
        totals_diff: validation.totals_diff,
        metrics: {
          input_tokens: extraction.input_tokens,
          output_tokens: extraction.output_tokens,
          duration_ms: totalMs,
        },
      },
    }).eq('id', jobId)

    return NextResponse.json({
      success: true,
      job_id: jobId,
      rows_extracted: extraction.products.length,
      duration_ms: totalMs,
    })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error(`[process-import] [${jobId}] unhandled error: ${msg}`)
    if (err?.stack) console.error(err.stack)
    if (jobId) await failJob(jobId, msg)
    return NextResponse.json({ error: msg, success: false }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabase } from '@/lib/supabase'
import { detectDocTypeFromFilename } from '@/lib/prompts'
import { extractFromBuffer } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'

export const runtime = 'nodejs'
export const maxDuration = 300

const LOCK_STALE_MS = Math.max(60_000, Number(process.env.IMPORT_JOB_LOCK_STALE_MS ?? 8 * 60_000))
const EXTRACT_TIMEOUT_MS = Math.max(20_000, Number(process.env.IMPORT_EXTRACT_TIMEOUT_MS ?? 90_000))
const MAX_RETRIES = Math.max(0, Number(process.env.IMPORT_JOB_MAX_RETRIES ?? 2))
const RETRY_BASE_DELAY_MS = Math.max(1000, Number(process.env.IMPORT_JOB_RETRY_BASE_DELAY_MS ?? 5000))

type ImportJob = {
  id: string
  status: string
  step: string | null
  progress_pct: number | null
  file_url: string
  file_name: string
  skip_db_insert: boolean | null
  result: Record<string, any> | null
  attempt_count?: number | null
  retry_at?: string | null
  updated_at: string
}

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

function isRetryableError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('thread killed by timeout manager') ||
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504') ||
    m.includes('bad gateway') ||
    m.includes('fetch failed') ||
    m.includes('network')
  )
}

function getRetryCount(job: ImportJob): number {
  return Number(job.result?.retry_count ?? 0)
}

async function queueRetry(job: ImportJob, message: string) {
  const retryCount = Math.max(getRetryCount(job), Number(job.attempt_count ?? 0)) + 1
  const canRetry = retryCount <= MAX_RETRIES
  const retryDelayMs = RETRY_BASE_DELAY_MS * retryCount
  const retryAt = new Date(Date.now() + retryDelayMs).toISOString()
  await supabase
    .from('import_jobs')
    .update({
      status: canRetry ? 'retryable' : 'failed',
      step: canRetry ? 'retrying' : 'failed',
      progress_pct: canRetry ? 0 : (job.progress_pct ?? 0),
      error: message,
      attempt_count: retryCount,
      retry_at: canRetry ? retryAt : null,
      result: {
        ...(job.result ?? {}),
        retry_count: retryCount,
        retry_delay_ms: retryDelayMs,
        retry_at: retryAt,
      },
    })
    .eq('id', job.id)
  console.warn(
    `[process-import] [${job.id}] ${canRetry ? 'retryable' : 'retry limit reached'} (${retryCount}/${MAX_RETRIES})`
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function claimJob(jobId: string): Promise<ImportJob | null> {
  const { data: job, error } = await supabase
    .from('import_jobs')
    .select('*')
    .eq('id', jobId)
    .single()
  if (error || !job) return null

  const staleCutoff = new Date(Date.now() - LOCK_STALE_MS).toISOString()
  const isClaimable = job.status === 'queued' || job.status === 'retryable'
  const retryWindowOpen =
    !job.retry_at || new Date(job.retry_at).getTime() <= Date.now()
  const isStaleProcessing = job.status === 'processing' && job.updated_at < staleCutoff
  if ((isClaimable && !retryWindowOpen) || (!isClaimable && !isStaleProcessing)) return null

  const { data: claimed, error: claimErr } = await supabase
    .from('import_jobs')
    .update({
      status: 'processing',
      step: isStaleProcessing ? 'recovering' : (job.step ?? 'processing'),
      retry_at: null,
      attempt_count: Number(job.attempt_count ?? 0) + 1,
    })
    .eq('id', jobId)
    .eq('status', job.status)
    .select('*')
    .maybeSingle()

  if (claimErr || !claimed) return null
  return claimed as ImportJob
}

export async function POST(req: Request) {
  const startMs = Date.now()
  let jobId = ''
  let activeJob: ImportJob | null = null

  try {
    const body = await req.json()
    jobId = body.job_id
    if (!jobId) {
      return NextResponse.json({ error: 'Missing job_id' }, { status: 400 })
    }

    const claimed = await claimJob(jobId)
    if (!claimed) {
      const { data: snapshot } = await supabase
        .from('import_jobs')
        .select('id,status,step,updated_at')
        .eq('id', jobId)
        .maybeSingle()
      if (!snapshot) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      return NextResponse.json({
        status: 'ignored',
        reason: `Job not claimable (status=${snapshot.status}, step=${snapshot.step})`,
      })
    }
    activeJob = claimed

    const { file_url: fileUrl, file_name: fileName, skip_db_insert: skipInsert } = activeJob

    await setStep(jobId, 'downloading', 5)
    const fileRes = await withTimeout(fetch(fileUrl), 30_000, 'file download')
    if (!fileRes.ok) {
      const msg = `Failed to download file: HTTP ${fileRes.status}`
      if (isRetryableError(msg)) await queueRetry(activeJob, msg)
      else await failJob(jobId, msg)
      return NextResponse.json({ error: 'Download failed' }, { status: 502 })
    }

    const content = Buffer.from(await fileRes.arrayBuffer())
    const fileSha256 = crypto.createHash('sha256').update(content).digest('hex')
    await setStep(jobId, 'downloading', 15, { progress_pct: 15 })

    const nameLower = fileName.toLowerCase()
    const isPdf = nameLower.endsWith('.pdf')
    const isImage = nameLower.endsWith('.png') || nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg')
    if (!isPdf && !isImage) {
      await failJob(jobId, `Unsupported file type: ${fileName}`)
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }
    const mediaType = isPdf ? 'application/pdf' : (nameLower.endsWith('.png') ? 'image/png' : 'image/jpeg')
    const docTypeHint = detectDocTypeFromFilename(fileName)

    await setStep(jobId, 'extracting', 20)
    const extraction = await withTimeout(
      extractFromBuffer(content, mediaType, docTypeHint),
      EXTRACT_TIMEOUT_MS,
      'Claude extraction'
    )
    if (extraction.products.length === 0) {
      await failJob(jobId, 'Claude extracted 0 rows — check the PDF is text-readable')
      return NextResponse.json({ error: 'No rows extracted' }, { status: 422 })
    }

    await setStep(jobId, 'validating', 80)
    const validation = validateExtraction(extraction.document, extraction.products)

    let documentId: string | null = null
    if (!skipInsert) {
      await setStep(jobId, 'saving', 88)
      const insertResult = await withTimeout(
        insertToSupabase(fileName, fileSha256, extraction, validation, []),
        60_000,
        'Supabase insert'
      )
      documentId = insertResult.document_id
    }

    const totalMs = Date.now() - startMs
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
        retry_count: getRetryCount(activeJob),
        metrics: {
          input_tokens: extraction.input_tokens,
          output_tokens: extraction.output_tokens,
          duration_ms: totalMs,
        },
      },
      error: null,
    }).eq('id', jobId)

    console.log(`[process-import] [${jobId}] ✓ completed in ${totalMs}ms`)
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
    if (jobId && activeJob) {
      if (isRetryableError(msg)) await queueRetry(activeJob, msg)
      else await failJob(jobId, msg)
    } else if (jobId) {
      await failJob(jobId, msg)
    }
    return NextResponse.json({ error: msg, success: false }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const runtime = 'nodejs'

/**
 * POST /api/queue-import
 * Body: { file_url, file_name, skip_db_insert? }
 *
 * Returns { job_id } immediately — no processing happens here.
 * The caller then:
 *   1. Subscribes to realtime on import_jobs WHERE id = job_id
 *   2. Fires POST /api/process-import with { job_id } (fire-and-forget)
 */
export async function POST(req: Request) {
  try {
    const { file_url, file_name, skip_db_insert, idempotency_key } = await req.json()

    if (!file_url || !file_name) {
      return NextResponse.json({ error: 'Missing file_url or file_name' }, { status: 400 })
    }

    // Reuse an active recent job for the same file to avoid duplicate stuck queue entries.
    const dedupeColumn = idempotency_key ? 'idempotency_key' : 'file_name'
    const dedupeValue = idempotency_key ?? file_name
    const { data: existing } = await supabase
      .from('import_jobs')
      .select('id,status,step,created_at')
      .eq(dedupeColumn, dedupeValue)
      .in('status', ['queued', 'processing', 'retryable', 'completed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existing?.id) {
      console.log(`[queue-import] reusing active job: ${existing.id} file=${file_name}`)
      return NextResponse.json({ job_id: existing.id, reused: true })
    }

    const { data, error } = await supabase
      .from('import_jobs')
      .insert({
        file_url,
        file_name,
        idempotency_key: idempotency_key ?? null,
        attempt_count: 0,
        retry_at: null,
        skip_db_insert: skip_db_insert ?? false,
        status: 'queued',
        step: 'queued',
        progress_pct: 0,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)

    console.log(`[queue-import] job created: ${data.id} file=${file_name}`)
    return NextResponse.json({ job_id: data.id })
  } catch (err: any) {
    console.error('[queue-import] error:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Failed to queue job' }, { status: 500 })
  }
}

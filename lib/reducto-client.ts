const REDUCTO_BASE = 'https://platform.reducto.ai'

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
  let parseRes: Response
  try {
    parseRes = await fetch(`${REDUCTO_BASE}/parse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
    })
  } catch (err: any) {
    throw new Error(`Reducto parse network error: ${err?.message ?? err}`)
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

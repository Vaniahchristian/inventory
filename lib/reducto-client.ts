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
  fileName: string
): Promise<ReductoExtractResult> {
  const apiKey = process.env.REDUCTO_API_KEY
  if (!apiKey) throw new Error('REDUCTO_API_KEY not set')

  // Step 1: Upload the file
  const uploadForm = new FormData()
  uploadForm.append(
    'file',
    new Blob([fileBuffer], { type: 'application/pdf' }),
    fileName
  )

  const uploadStart = Date.now()
  const uploadRes = await fetch(`${REDUCTO_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: uploadForm,
  })
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => uploadRes.statusText)
    throw new Error(`Reducto upload failed (${uploadRes.status}): ${err}`)
  }
  const { file_id } = await uploadRes.json()
  console.log(`[reducto] uploaded in ${Date.now() - uploadStart}ms — file_id: ${file_id}`)

  // Step 2: Parse
  // HTML table format preserves colspan/rowspan — critical for merged cells (T.CTN, MARKS).
  // Agentic table scope adds AI-powered table structure understanding.
  const parseStart = Date.now()
  const parseRes = await fetch(`${REDUCTO_BASE}/parse`, {
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
  if (!parseRes.ok) {
    const err = await parseRes.text().catch(() => parseRes.statusText)
    throw new Error(`Reducto parse failed (${parseRes.status}): ${err}`)
  }
  const parsed: ReductoParseResult = await parseRes.json()
  console.log(
    `[reducto] parsed in ${Date.now() - parseStart}ms (api: ${parsed.duration}s) — pages: ${parsed.usage.num_pages} credits: ${parsed.usage.credits}`
  )

  // Concatenate all chunk content — Reducto returns markdown prose + HTML table blocks
  const text = parsed.result.chunks
    .map(chunk => chunk.content)
    .filter(Boolean)
    .join('\n\n')

  return {
    text,
    pageCount: parsed.usage.num_pages,
    jobId: parsed.job_id,
    credits: parsed.usage.credits,
  }
}

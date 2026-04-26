import { NextResponse } from 'next/server'
import vision from '@google-cloud/vision'
import path from 'path'
import { linesToRows } from '@/lib/ocr-parser'

export const runtime = 'nodejs'

const KEY_FILE = path.join(process.cwd(), 'rosy-cogency-494512-n2-1755231a72ea.json')

function makeClient() {
  return new vision.ImageAnnotatorClient({ keyFilename: KEY_FILE })
}

async function extractRowsWithLlm(lines: string[]): Promise<Record<string, string>[]> {
  const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY
  if (!apiKey) return []

  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '')
  const model = process.env.LLM_MODEL || process.env.GROQ_MODEL || 'deepseek/deepseek-chat-v3-0324'
  const ocrText = lines.join('\n').slice(0, 7000)

  const prompt = `You are a data extraction engine for Chinese packing lists and sales orders (销售单).
The text below was extracted via OCR from a multi-column PDF table. Columns may appear scrambled or interleaved.
Reconstruct ALL product rows. Skip rows that are clearly header/footer/total lines.

Return a JSON array where each element has EXACTLY these keys:
"MARKS", "SHOP#", "ITEM NO.", "DESCRIPTION OF GOODS", "PACKING", "T.CTN", "T.QTY", "UNIT CBM", "T.CBM", "UNIT WEIGHT", "T.WEIGHT", "U.PRICE (RMB)", "T.AMOUNT"

CRITICAL rules:
- MARKS: short product code/SKU only — no spaces (e.g. "SE-030", "BL6015W1", "VF013C", "TN55M2"). Never a full sentence.
- DESCRIPTION OF GOODS: REQUIRED — English product name (e.g. "5L Air Fryer", "1.3L Vacuum Jug"). Look for English words near the SKU. Never leave blank if any English description exists.
- PACKING: REQUIRED — must contain a slash, format "Npcs/ctn" (e.g. "2pcs/ctn", "12pcs/ctn"). Derive from pcs-per-carton data visible in the row.
- T.CTN: total cartons with unit, e.g. "30CTNS"
- T.QTY: total pieces, e.g. "360pcs"
- UNIT CBM: per-carton cubic metres, e.g. "0.11CBM"
- T.CBM: total cubic metres, e.g. "1.06CBM"
- UNIT WEIGHT: per-carton weight, e.g. "11.5KGS"
- T.WEIGHT: total weight, e.g. "115KGS"
- U.PRICE (RMB): unit price with ¥ symbol, e.g. "¥47"
- T.AMOUNT: total amount with ¥ symbol, e.g. "¥5640"
- SHOP#: warehouse if visible (e.g. "浦江仓"), else ""
- ITEM NO.: order reference if visible (e.g. "C25-6083"), else ""
- Use "" for truly unknown values — never null, never skip DESCRIPTION or PACKING
- Skip rows where quantity AND cartons are both 0
- Output ONLY the raw JSON array. No markdown. No explanation.

OCR text:
${ocrText}`

  console.log('[ocr-extract] LLM fallback: sending', lines.length, 'lines to', model)
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.LLM_REFERER ? { 'HTTP-Referer': process.env.LLM_REFERER } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a strict data extraction engine. Output JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!res.ok) {
      console.error('[ocr-extract] LLM status:', res.status)
      return []
    }
    const data = await res.json()
    const content = String(data?.choices?.[0]?.message?.content ?? '')
    console.log('[ocr-extract] LLM response preview:', content.slice(0, 300))
    const start = content.indexOf('[')
    const end = content.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) return []
    const parsed = JSON.parse(content.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch (err: any) {
    console.error('[ocr-extract] LLM fallback error:', err?.message)
    return []
  }
}

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    }

    const name = file.name.toLowerCase()
    const isPdf = name.endsWith('.pdf')
    const isImage = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')
    if (!isPdf && !isImage) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    console.log('[ocr-extract] processing:', file.name, 'size:', file.size, 'bytes')
    const content = Buffer.from(await file.arrayBuffer())
    const client = makeClient()
    const lines: string[] = []

    if (isPdf) {
      const [batchResult] = await client.batchAnnotateFiles({
        requests: [{
          inputConfig: { content, mimeType: 'application/pdf' },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        }],
      })
      console.log('[ocr-extract] batchAnnotateFiles responses:', batchResult.responses?.length ?? 0)
      for (const fileResp of batchResult.responses ?? []) {
        const pageResponses = (fileResp as any).responses ?? []
        console.log('[ocr-extract] pages:', pageResponses.length)
        for (const pageResp of pageResponses) {
          const text: string = pageResp.fullTextAnnotation?.text ?? ''
          const pageLines = text.split('\n').filter(Boolean)
          console.log('[ocr-extract] page lines:', pageLines.length, '| preview:', pageLines.slice(0, 2).join(' | '))
          lines.push(...pageLines)
        }
      }
    } else {
      const [result] = await client.annotateImage({
        image: { content },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      })
      const text: string = result.fullTextAnnotation?.text ?? ''
      lines.push(...text.split('\n').filter(Boolean))
    }

    console.log('[ocr-extract] total OCR lines:', lines.length)

    // Try regex parser first
    let rows = linesToRows(lines)
    console.log('[ocr-extract] regex parser rows:', rows.length)

    // If regex parser found nothing but OCR has content, let the LLM reconstruct the table
    if (rows.length === 0 && lines.length > 0) {
      console.log('[ocr-extract] falling back to LLM table reconstruction')
      rows = await extractRowsWithLlm(lines)
      console.log('[ocr-extract] LLM extracted rows:', rows.length)
    }

    return NextResponse.json({ rows, lines, metrics: { ocr_lines: lines.length, parsed_rows: rows.length } })
  } catch (err: any) {
    console.error('[ocr-extract] error:', err?.message ?? err)
    return NextResponse.json({ rows: [], lines: [], message: err?.message ?? 'OCR request failed' }, { status: 200 })
  }
}

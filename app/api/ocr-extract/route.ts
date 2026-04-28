import { NextResponse } from 'next/server'
import vision from '@google-cloud/vision'
import path from 'path'
import crypto from 'crypto'
import { detectDocType } from '@/lib/prompts'
import { extractWithClaude } from '@/lib/claude-extractor'
import { validateExtraction } from '@/lib/validator'
import { insertToSupabase } from '@/lib/supabase-inserter'

export const runtime = 'nodejs'

const KEY_FILE = path.join(process.cwd(), 'rosy-cogency-494512-n2-1755231a72ea.json')

// Vision API hard limit is 5 pages per batchAnnotateFiles call.
// We split the page list into batches of 5 and merge all lines.
const VISION_PAGE_BATCH = 5
const MAX_PDF_PAGES = 20

async function runOCR(content: Buffer, isPdf: boolean): Promise<string[]> {
  const client = new vision.ImageAnnotatorClient({ keyFilename: KEY_FILE })
  const lines: string[] = []

  if (isPdf) {
    // Build page batches: [1..5], [6..10], [11..15], [16..20]
    const batches: number[][] = []
    for (let start = 1; start <= MAX_PDF_PAGES; start += VISION_PAGE_BATCH) {
      batches.push(
        Array.from(
          { length: VISION_PAGE_BATCH },
          (_, i) => start + i
        )
      )
    }

    for (const pageBatch of batches) {
      console.log(`[ocr] requesting pages ${pageBatch[0]}–${pageBatch[pageBatch.length - 1]}`)
      try {
        const [batchResult] = await client.batchAnnotateFiles({
          requests: [{
            inputConfig: { content, mimeType: 'application/pdf' },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            pages: pageBatch,
          }],
        })

        const pageResponses = (batchResult.responses?.[0] as any)?.responses ?? []
        console.log(`[ocr] pages returned: ${pageResponses.length}`)

        if (pageResponses.length === 0) {
          // No pages returned means we've gone past the end of the document
          console.log('[ocr] no more pages — stopping')
          break
        }

        for (const pageResp of pageResponses) {
          const text: string = pageResp.fullTextAnnotation?.text ?? ''
          if (text) {
            lines.push(...text.split('\n').filter(Boolean))
          }
        }

        // If fewer pages came back than requested, we've hit the end
        if (pageResponses.length < VISION_PAGE_BATCH) {
          console.log('[ocr] reached last page')
          break
        }
      } catch (err: any) {
        // Vision throws if the page range is entirely beyond the document
        if (err?.message?.includes('INVALID_ARGUMENT') || err?.code === 3) {
          console.log(`[ocr] page batch ${pageBatch[0]}+ beyond document end, stopping`)
          break
        }
        throw err
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

  return lines
}

export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    const form = await req.formData()
    const file = form.get('file')
    const skipInsert = form.get('skip_insert') === 'true'

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    }

    const name = file.name.toLowerCase()
    const isPdf = name.endsWith('.pdf')
    const isImage = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')
    if (!isPdf && !isImage) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
    }

    console.log(`[route] file: ${file.name} size: ${file.size}`)
    const content = Buffer.from(await file.arrayBuffer())
    const fileSha256 = crypto.createHash('sha256').update(content).digest('hex')

    // Step 1: Google Vision OCR (batched, handles any page count)
    console.log('[route] running OCR...')
    const lines = await runOCR(content, isPdf)
    console.log(`[route] ocr_lines: ${lines.length}`)

    if (lines.length === 0) {
      return NextResponse.json({ error: 'OCR returned no text' }, { status: 422 })
    }

    // Step 2: Detect document type from header lines
    const docType = detectDocType(lines)
    console.log(`[route] doc_type: ${docType}`)

    // Step 3: Single Claude call — full document, no per-row loops
    console.log('[route] calling Claude...')
    const extraction = await extractWithClaude(lines, docType)
    console.log(`[route] extracted rows: ${extraction.products.length}`)

    if (extraction.products.length === 0) {
      return NextResponse.json({ error: 'Claude extracted 0 rows' }, { status: 422 })
    }

    // Step 4: Validate totals against PDF footer checksums
    const validation = validateExtraction(extraction.document, extraction.products)

    // Step 5: Supabase insert
    let insertResult = null
    if (!skipInsert) {
      console.log('[route] inserting to Supabase...')
      insertResult = await insertToSupabase(file.name, fileSha256, extraction, validation, lines)
    }

    const duration = Date.now() - startTime
    console.log(`[route] done in ${duration}ms`)

    return NextResponse.json({
      success: true,
      document_id: insertResult?.document_id ?? null,
      doc_type: docType,
      rows_extracted: extraction.products.length,
      rows_pass: validation.pass_count,
      rows_flagged: validation.flag_count,
      totals_match: validation.totals_match,
      totals_diff: validation.totals_diff,
      validation_flags: validation.validation_flags,
      truncated: extraction.truncated,
      metrics: {
        ocr_lines: lines.length,
        input_tokens: extraction.input_tokens,
        output_tokens: extraction.output_tokens,
        duration_ms: duration,
      },
      products: extraction.products,
      document: extraction.document,
      lines,
    })
  } catch (err: any) {
    console.error('[route] error:', err?.message ?? err)
    return NextResponse.json(
      { error: err?.message ?? 'Extraction failed', success: false },
      { status: 500 }
    )
  }
}
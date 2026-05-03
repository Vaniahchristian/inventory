'use server'

import type { ClaudeExtractionResult } from '@/lib/claude-extractor'
import { isFullExtractBanner } from '@/lib/full-extract'
import { coerceDocument, coerceProductArray } from '@/lib/extract-coerce'
import { insertToSupabase } from '@/lib/supabase-inserter'
import crypto from 'crypto'

export type LiveViewSavePayload = {
  fileName: string
  document: unknown
  products: unknown[]
  model: string
}

/**
 * Persist a user-reviewed extraction from Live View (same path as /api/extract insert).
 */
export async function saveLiveViewExtraction(payload: LiveViewSavePayload) {
  const fileName = payload.fileName?.trim() || 'document.pdf'
  const coerced = coerceProductArray(payload.products)
  const productsForDb = coerced.filter(p => !isFullExtractBanner(p))
  const extraction: ClaudeExtractionResult = {
    document: coerceDocument(payload.document),
    products: productsForDb,
    model: payload.model || 'live_view',
    input_tokens: 0,
    output_tokens: 0,
    truncated: false,
  }

  const hashInput = JSON.stringify({ document: extraction.document, products: extraction.products })
  const fileSha256 = crypto.createHash('sha256').update(hashInput).digest('hex')

  return insertToSupabase(fileName, fileSha256, extraction, [])
}

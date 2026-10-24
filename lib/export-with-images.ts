'use client'

/** Fetch a remote image for Excel embedding. Returns null on failure. */
export async function fetchImageForExport(
  url: string | null | undefined
): Promise<{ buffer: ArrayBuffer; extension: 'jpeg' | 'png' | 'gif' } | null> {
  const src = (url ?? '').trim()
  if (!src || !/^https?:\/\//i.test(src)) return null
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    if (!buffer.byteLength) return null
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    let extension: 'jpeg' | 'png' | 'gif' = 'jpeg'
    if (ct.includes('png') || /\.png(\?|$)/i.test(src)) extension = 'png'
    else if (ct.includes('gif') || /\.gif(\?|$)/i.test(src)) extension = 'gif'
    return { buffer, extension }
  } catch {
    return null
  }
}

export function downloadArrayBuffer(
  buffer: ArrayBuffer | Uint8Array | BlobPart,
  fileName: string,
  mime: string
) {
  const blob = new Blob([buffer as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export function photoImgHtml(url: string | null | undefined, size = 48): string {
  const src = (url ?? '').trim()
  if (!src) return ''
  const esc = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<img src="${esc}" alt="" width="${size}" height="${size}" style="object-fit:cover;border-radius:2px;display:block;" />`
}

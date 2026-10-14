import { renderPwaIcon } from '@/lib/pwa-icon'

/** Maskable icons need the glyph inside the central safe zone (~80%), so it is drawn smaller. */
const ICONS: Record<string, { size: number; scale: number }> = {
  'icon-192.png': { size: 192, scale: 0.6 },
  'icon-512.png': { size: 512, scale: 0.6 },
  'maskable-512.png': { size: 512, scale: 0.45 },
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const icon = ICONS[(await params).name]
  if (!icon) return new Response('Not found', { status: 404 })
  const res = renderPwaIcon(icon.size, icon.scale)
  res.headers.set('Cache-Control', 'public, max-age=86400, immutable')
  return res
}

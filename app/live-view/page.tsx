import type { Metadata } from 'next'
import { LiveViewClient } from './live-view-client'

export const metadata: Metadata = {
  title: 'Live View — Extraction',
}

export default function LiveViewPage() {
  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <LiveViewClient />
    </div>
  )
}

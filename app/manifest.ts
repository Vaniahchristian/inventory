import type { MetadataRoute } from 'next'
import { PWA_THEME_COLOR } from '@/lib/pwa-icon'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KizitoInventory',
    short_name: 'Inventory',
    description: 'Warehouse inventory management system',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: PWA_THEME_COLOR,
    icons: [
      { src: '/pwa-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

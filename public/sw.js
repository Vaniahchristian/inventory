// Network-only on purpose: stock figures must always come live from the database.
// The worker only exists so the app is installable and shows a friendly page when offline.

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · KizitoInventory</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:system-ui,sans-serif;color:#0f172a}
main{text-align:center;padding:24px}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#64748b;margin:0 0 16px}
button{background:#0f172a;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer}</style></head>
<body><main><h1>You're offline</h1><p>KizitoInventory needs a connection to show live stock.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    )
  )
})

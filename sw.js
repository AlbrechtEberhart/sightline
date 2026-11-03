// Stale-while-revalidate shell cache for same-origin GETs.
// .onnx models are cached by models.js; Range requests must hit the network.
const CACHE = 'cv-shell-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('cv-shell-')).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('.onnx')) return
  if (req.headers.has('range')) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(req)
    const network = fetch(req).then((res) => {
      if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {})
      return res
    })
    if (cached) {
      network.catch(() => {})
      return cached
    }
    return network
  })())
})

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

function cacheable(url) {
  return url.origin === self.location.origin && !url.pathname.endsWith('.onnx')
}

// Only store complete, same-origin (basic) 200 responses.
async function store(req, res) {
  if (res.ok && res.status === 200 && res.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(req, res.clone())
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (!cacheable(new URL(req.url))) return
  if (req.headers.has('range')) return

  // Start the refresh synchronously so waitUntil keeps the worker alive until cache.put finishes.
  const refresh = fetch(req).then(async (res) => { await store(req, res); return res })
  event.waitUntil(refresh.catch(() => {}))
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(req)
    return cached || refresh
  })())
})

// The page posts the URLs it loaded before this worker controlled it, so offline works after first visit.
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'cache-urls' || !Array.isArray(data.urls)) return
  event.waitUntil(Promise.all(data.urls.map(async (u) => {
    try {
      const url = new URL(u, self.location.href)
      if (!cacheable(url)) return
      const req = new Request(url.href)
      await store(req, await fetch(req))
    } catch { /* ignore individual failures */ }
  })))
})

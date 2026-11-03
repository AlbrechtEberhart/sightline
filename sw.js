// Network-first shell cache for same-origin GETs.
// Every request goes to the network first (revalidated with the ETag, so an unchanged file
// is a cheap 304), which means a phone gets fresh code right after every deploy, and Live
// and Studio, which share modules, never run a mix of old and new versions. The cache is
// only the offline fallback.
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
const storable = (res) => res.ok && res.status === 200 && res.type === 'basic'

async function store(req, res) {
  if (storable(res)) {
    const cache = await caches.open(CACHE)
    await cache.put(req, res)
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (!cacheable(new URL(req.url))) return
  if (req.headers.has('range')) return

  // Revalidate with the server (ETag -> 304 when unchanged) instead of trusting the HTTP cache.
  const network = fetch(req, { cache: 'no-cache' })
  // The copy is taken synchronously, before the page reads the body. The response never
  // waits on cache.put, and a put error never fails the response.
  event.waitUntil(network.then((res) => (storable(res) ? store(req, res.clone()) : undefined)).catch(() => {}))
  event.respondWith(network.catch(async (err) => {
    const cached = await caches.match(req) ||
      (req.mode === 'navigate' ? await caches.match(req, { ignoreSearch: true }) : undefined)
    if (cached) return cached
    throw err
  }))
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
      await store(req, await fetch(req)).catch(() => {})
    } catch { /* ignore individual failures */ }
  })))
})

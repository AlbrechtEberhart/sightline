// Model download (cached in Cache Storage, shared by Live and Studio) and ORT session creation.
import { ort } from './lib/ort.js'

// Bump the version whenever the model files change under the same URL, otherwise phones keep the old model.
export const CACHE_NAME = 'cv-models-v1'
const MIN_MODEL_BYTES = 1000000

export const MODEL_URLS = {
  320: new URL('../models/yolo11n-320.onnx', import.meta.url),
  640: new URL('../models/yolo11n-640.onnx', import.meta.url),
}

function downloadError(message, cause) {
  const e = new Error(message)
  e.name = 'ModelDownloadError'
  if (cause !== undefined) e.cause = cause
  return e
}

async function openCache() {
  try {
    if (typeof caches === 'undefined') return null
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

function totalOf(res) {
  return Number(res.headers.get('Content-Length')) || 0
}

async function readBody(res, onProgress) {
  const total = totalOf(res)
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (onProgress) onProgress(buf.byteLength, total || buf.byteLength)
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (onProgress) onProgress(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

// Returns an error message if the response/bytes are not a plausible complete model, else null.
function problemWith(res, bytes) {
  const total = totalOf(res)
  // With Content-Encoding (gzip/br), Content-Length is the compressed size, so skip the comparison.
  if (total && bytes.byteLength < total && !res.headers.get('Content-Encoding')) {
    return `truncated body (${bytes.byteLength} of ${total} bytes)`
  }
  if ((res.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) {
    return 'unexpected text/html response'
  }
  if (bytes.byteLength < MIN_MODEL_BYTES) {
    return `body too small (${bytes.byteLength} bytes)`
  }
  return null
}

// Throws ModelDownloadError if the response/bytes are not a plausible complete model.
export function validateDownload(res, bytes) {
  const problem = problemWith(res, bytes)
  if (problem) throw downloadError(`Model download invalid: ${problem}`)
}

export async function fetchModel(url, onProgress) {
  const href = typeof url === 'string' ? url : url.href
  const cache = await openCache()

  if (cache) {
    try {
      const hit = await cache.match(href)
      if (hit) {
        const bytes = await readBody(hit.clone(), null)
        if (!problemWith(hit, bytes)) {
          if (onProgress) onProgress(bytes.byteLength, bytes.byteLength)
          return bytes
        }
        await cache.delete(href) // bad entry: evict and re-download
      }
    } catch {
      try { await cache.delete(href) } catch { /* ignore */ }
    }
  }

  let res, bytes
  try {
    res = await fetch(href)
    if (!res.ok) throw downloadError(`Model download failed (${href}): HTTP ${res.status}`)
    bytes = await readBody(res, onProgress)
  } catch (e) {
    if (e && e.name === 'ModelDownloadError') throw e
    throw downloadError(`Model download failed (${href}): ${e && e.message}`, e)
  }

  const problem = problemWith(res, bytes)
  if (problem) throw downloadError(`Model download failed (${href}): ${problem}`)

  if (cache) {
    try {
      // Fresh Response from the bytes: the network body is already consumed.
      await cache.put(href, new Response(bytes, {
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
      }))
    } catch { /* caching is best-effort */ }
  }
  return bytes
}

export async function createSession(bytes, { backend = 'auto' } = {}) {
  if (backend === 'auto' || backend === 'webgpu') {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU unavailable')
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] })
      return { session, backend: 'webgpu' }
    } catch (e) {
      if (backend === 'webgpu') throw e
      // auto: fall through to WASM
    }
  }
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
  return { session, backend: 'wasm' }
}

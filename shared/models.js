// Model download (cached in Cache Storage, shared by Live and Studio) and ORT session creation.
import { ort } from './lib/ort.js'

export const CACHE_NAME = 'cv-models-v1'

export const MODEL_URLS = {
  320: new URL('../models/yolo11n-320.onnx', import.meta.url),
  640: new URL('../models/yolo11n-640.onnx', import.meta.url),
}

function downloadError(message) {
  const e = new Error(message)
  e.name = 'ModelDownloadError'
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

async function readBody(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || 0
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

export async function fetchModel(url, onProgress) {
  const href = typeof url === 'string' ? url : url.href
  const cache = await openCache()

  if (cache) {
    try {
      const hit = await cache.match(href)
      if (hit) return await readBody(hit, onProgress)
    } catch { /* fall through to network */ }
  }

  let res
  try {
    res = await fetch(href)
  } catch (e) {
    throw downloadError(`Model download failed (${href}): ${e.message}`)
  }
  if (!res.ok) throw downloadError(`Model download failed (${href}): HTTP ${res.status}`)

  const bytes = await readBody(res, onProgress)

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

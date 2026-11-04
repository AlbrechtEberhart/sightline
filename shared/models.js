// Model download (cached in Cache Storage, shared by Live and Studio) and ORT session creation.
import { ort } from './lib/ort.js'

// Bump the version whenever the model files change under the same URL, otherwise phones keep the old model.
export const CACHE_NAME = 'cv-models-v1'
const MIN_MODEL_BYTES = 1000000

export const MODEL_URLS = {
  320: new URL('../models/yolo11n-320.onnx', import.meta.url),
  640: new URL('../models/yolo11n-640.onnx', import.meta.url),
}

// OpenCV.js for Panorama. Task 3 fills in the real size and SHA-256 once the file is vendored.
export const OPENCV_ASSET = {
  url: new URL('./vendor/opencv/opencv.js', import.meta.url),
  bytes: 0,
  sha256: '',
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

// Returns an error message if the response/bytes are not a plausible complete file, else null.
function problemWith(res, bytes, minBytes = MIN_MODEL_BYTES) {
  const total = totalOf(res)
  // With Content-Encoding (gzip/br), Content-Length is the compressed size, so skip the comparison.
  if (total && bytes.byteLength < total && !res.headers.get('Content-Encoding')) {
    return `truncated body (${bytes.byteLength} of ${total} bytes)`
  }
  if ((res.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) {
    return 'unexpected text/html response'
  }
  if (bytes.byteLength < minBytes) {
    return `body too small (${bytes.byteLength} bytes)`
  }
  return null
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Response checks plus the pinned size and SHA-256 (0 / '' mean "not checked"). Returns a message or null.
async function assetProblem(res, bytes, { bytes: size = 0, sha256 = '', minBytes }) {
  const problem = problemWith(res, bytes, minBytes)
  if (problem) return problem
  if (size && bytes.byteLength !== size) {
    return `size mismatch (${bytes.byteLength} bytes, expected ${size})`
  }
  if (sha256 && await sha256Hex(bytes) !== sha256.toLowerCase()) return 'hash mismatch'
  return null
}

// Throws ModelDownloadError if the response/bytes are not a plausible complete model.
export function validateDownload(res, bytes) {
  const problem = problemWith(res, bytes)
  if (problem) throw downloadError(`Model download invalid: ${problem}`)
}

// Downloads a file (cached in Cache Storage) and checks it. Bytes that fail a check are never cached or returned.
export async function fetchAsset(url, { bytes: size = 0, sha256 = '', minBytes = MIN_MODEL_BYTES, onProgress } = {}) {
  const href = typeof url === 'string' ? url : url.href
  const expect = { bytes: size, sha256, minBytes }
  const cache = await openCache()

  if (cache) {
    try {
      const hit = await cache.match(href)
      if (hit) {
        const bytes = await readBody(hit.clone(), null)
        if (!await assetProblem(hit, bytes, expect)) {
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

  const problem = await assetProblem(res, bytes, expect)
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

export function fetchModel(url, onProgress) {
  return fetchAsset(url, { onProgress })
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

import { test, assert, assertEqual, fixture } from './harness.js'
import { fetchModel, fetchAsset, createSession, validateDownload, MODEL_URLS } from '../shared/models.js'
test('models: fetch caches', async () => {
  await caches.delete('cv-models-v1')
  const a = await fetchModel(MODEL_URLS[320])
  assert(a.byteLength > 9e6)
  assert(await (await caches.open('cv-models-v1')).match(MODEL_URLS[320].href))
  const calls = []
  const b = await fetchModel(MODEL_URLS[320], (loaded, total) => calls.push([loaded, total]))
  assert(calls.length > 0, 'onProgress was called')
  const [loaded, total] = calls[calls.length - 1]
  assertEqual(loaded, a.byteLength)
  assertEqual(total, a.byteLength)
  assertEqual(b.byteLength, a.byteLength)
})
test('models: missing file rejects ModelDownloadError', async () => {
  const url = new URL('../models/missing.onnx', location.href)
  let err; try { await fetchModel(url) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
  assertEqual(await (await caches.open('cv-models-v1')).match(url.href), undefined)
})
test('models: html 200 is rejected and not cached', async () => {
  const url = new URL('../index.html', import.meta.url)
  let err; try { await fetchModel(url) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
  assertEqual(await (await caches.open('cv-models-v1')).match(url.href), undefined)
})
test('models: wasm session', async () => {
  const { session, backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'wasm' })
  assertEqual(backend, 'wasm'); assertEqual(session.inputNames.length, 1)
})
test('models: auto picks a backend', async () => {
  const { backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'auto' })
  assert(backend === 'webgpu' || backend === 'wasm')
})
test('models: auto falls back to wasm without WebGPU', async () => {
  const bytes = await fetchModel(MODEL_URLS[320])
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
  try {
    const { backend } = await createSession(bytes, { backend: 'auto' })
    assertEqual(backend, 'wasm')
  } finally {
    delete navigator.gpu
  }
})
test('models: compressed length mismatch is accepted', async () => {
  const fake = (headers) => ({ headers: new Headers(headers) })
  const body = new Uint8Array(10600000)
  validateDownload(fake({ 'content-encoding': 'gzip', 'content-length': '12000000' }), body)
  let err
  try { validateDownload(fake({ 'content-length': '12000000' }), body) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
})
const busUrl = new URL('./fixtures/bus.jpg', import.meta.url)
async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function uncache(url) { await (await caches.open('cv-models-v1')).delete(url.href) }
test('models: fetchAsset rejects a hash mismatch and does not cache it', async () => {
  await uncache(busUrl)
  let err; try { await fetchAsset(busUrl, { minBytes: 0, sha256: 'ab'.repeat(32) }) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
  assert(err.message.includes('hash mismatch'), err.message)
  assertEqual(await (await caches.open('cv-models-v1')).match(busUrl.href), undefined)
})
test('models: fetchAsset rejects a size mismatch', async () => {
  await uncache(busUrl)
  let err; try { await fetchAsset(busUrl, { minBytes: 0, bytes: 1 }) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
  assert(err.message.includes('size mismatch'), err.message)
  assertEqual(await (await caches.open('cv-models-v1')).match(busUrl.href), undefined)
})
test('models: fetchAsset accepts the right hash', async () => {
  await uncache(busUrl)
  const expected = new Uint8Array(await (await fixture('bus.jpg')).arrayBuffer())
  const got = await fetchAsset(busUrl, { minBytes: 0, bytes: expected.byteLength, sha256: await sha256Hex(expected) })
  assertEqual(got.byteLength, expected.byteLength)
  assertEqual(await sha256Hex(got), await sha256Hex(expected))
  await uncache(busUrl)
})

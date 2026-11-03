import { test, assert, assertEqual } from './harness.js'
import { fetchModel, createSession, MODEL_URLS } from '../shared/models.js'
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

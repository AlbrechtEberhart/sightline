import { test, assert, assertEqual } from './harness.js'
import { fetchModel, createSession, MODEL_URLS } from '../shared/models.js'
test('models: fetch caches', async () => {
  await caches.delete('cv-models-v1')
  const a = await fetchModel(MODEL_URLS[320])
  assert(a.byteLength > 9e6)
  assert(await (await caches.open('cv-models-v1')).match(MODEL_URLS[320].href))
})
test('models: missing file rejects ModelDownloadError', async () => {
  let err; try { await fetchModel(new URL('../models/missing.onnx', location.href)) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
})
test('models: wasm session', async () => {
  const { session, backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'wasm' })
  assertEqual(backend, 'wasm'); assertEqual(session.inputNames.length, 1)
})
test('models: auto picks a backend', async () => {
  const { backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'auto' })
  assert(backend === 'webgpu' || backend === 'wasm')
  globalThis.__autoBackend = backend
})

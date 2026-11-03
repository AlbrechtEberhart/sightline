import { test, assert } from './harness.js'
test('vendor: ort loads', async () => {
  const { ort } = await import('../shared/lib/ort.js')
  assert(typeof ort.InferenceSession.create === 'function')
  assert(ort.env.wasm.numThreads === 1)
})
test('vendor: mp4box loads', async () => {
  const MP4Box = (await import('../shared/lib/mp4box.js')).default
  assert(typeof MP4Box.createFile === 'function')
})
test('vendor: mp4-muxer loads', async () => {
  const m = await import('../shared/lib/mp4-muxer.js')
  assert(typeof m.Muxer === 'function' && typeof m.ArrayBufferTarget === 'function')
})

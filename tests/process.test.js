import { test, assert, assertEqual, fixture } from './harness.js'
import { processClip, estimateSeconds, summarize, frameIndexAt } from '../recorded/yolo/process.js'
import { FileVideoSource } from '../recorded/video-source.js'
import { createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
const det = async () => createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
const car = { label: 'car' }, bus = { label: 'bus' }
test('process: summarize', () => assertEqual(summarize([[car, car], [car, bus], [], null]), [{ label: 'car', frames: 2 }, { label: 'bus', frames: 1 }]))
test('process: estimateSeconds', () => assertEqual(estimateSeconds(1800, 2, 100), 90))
test('process: frameIndexAt', () => { assertEqual(frameIndexAt([0, 0.033, 0.066], 0.04), 1); assertEqual(frameIndexAt([0, 0.033, 0.066], 9), 2) })
test('process: step 2 over bus clip', async () => {
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { step: 2 })
  assertEqual([r.detections.length, r.times.length, r.completed], [90, 90, true])
  assertEqual(r.detections[1], r.detections[0]); assert(r.detections.some(d => d.some(b => b.label === 'bus')))
})
test('process: startFrame resumes', async () => {
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { startFrame: 45 })
  assertEqual(r.detections.findIndex(d => d !== null), 45)
})
test('process: processClip cancel stops early', async () => {
  const ac = new AbortController()
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(),
    { signal: ac.signal, onProgress: done => { if (done === 10) ac.abort() } })
  assertEqual(r.completed, false); assert(r.lastFrame >= 9 && r.lastFrame <= 20, String(r.lastFrame))
  const again = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { step: 3 })
  assertEqual(again.completed, true)
})

// ---- stub-based tests: no model, no decoder ----
function fakeSource(N, { yieldCount = N } = {}) {
  const s = { meta: { frameCount: N }, closed: new Map(), yielded: 0, stopped: 0 }
  s.frames = async function* ({ startFrame = 0 } = {}) {
    for (let i = startFrame; i < Math.min(N, yieldCount); i++) {
      s.yielded++
      yield { image: { i, close() { s.closed.set(i, (s.closed.get(i) || 0) + 1) } }, t: i / 30, index: i }
    }
  }
  s.stop = () => { s.stopped++ }
  return s
}
const fakeDetector = (throwAt = -1) => ({
  async detect(image) {
    if (image.i === throwAt) throw new Error('boom at ' + throwAt)
    return [{ classId: 2, label: 'car', score: 0.9, box: [0, 0, 1, 1] }]
  },
})
test('process: prior merge on resume', async () => {
  const N = 10
  const prior = { detections: [0, 1, 2, 3, 4].map(i => [{ label: 'p' + i }]), times: [0, 1, 2, 3, 4].map(i => i / 30) }
  const r = await processClip(fakeSource(N), fakeDetector(), { startFrame: 5, prior })
  for (let i = 0; i < 5; i++) {
    assert(r.detections[i] === prior.detections[i], 'detections[' + i + '] is prior reference')
    assertEqual(r.times[i], prior.times[i])
  }
  assertEqual([r.completed, r.lastFrame, r.detections.length], [true, N - 1, N])
})
test('process: detector error returns partial result', async () => {
  const src = fakeSource(10)
  const r = await processClip(src, fakeDetector(3), {})
  assertEqual([r.completed, r.lastFrame], [false, 2])
  assert(r.error instanceof Error, 'error set')
  assertEqual(src.yielded, 4)
  for (let i = 0; i < src.yielded; i++) assertEqual(src.closed.get(i), 1)
  assertEqual(src.stopped, 1)
})
test('process: truncated clip reports TruncatedClipError', async () => {
  const src = fakeSource(10, { yieldCount: 6 })
  const r = await processClip(src, fakeDetector(), {})
  assertEqual([r.completed, r.lastFrame, r.error && r.error.name], [false, 5, 'TruncatedClipError'])
  assertEqual(r.error.message, 'decoder ended at frame 6 of 10')
  assertEqual(src.stopped, 1)
})
test('process: user abort is not an error', async () => {
  const ac = new AbortController()
  const r = await processClip(fakeSource(10), fakeDetector(), { signal: ac.signal, onProgress: d => { if (d === 4) ac.abort() } })
  assertEqual([r.completed, r.lastFrame, 'error' in r], [false, 3, false])
})
test('process: onProgress args', async () => {
  const calls = []
  const r = await processClip(fakeSource(10), fakeDetector(), { startFrame: 4, onProgress: (d, t, e) => calls.push([d, t, e]) })
  assertEqual(r.completed, true)
  assertEqual(calls.map(c => c[0]), [1, 2, 3, 4, 5, 6])
  assert(calls.every(c => c[1] === 6), 'total === N - startFrame')
  // onProgress fires after a frame is handled and the first frame is always processed, so eta is never NaN here.
  assert(calls.every(c => Number.isFinite(c[2]) && c[2] >= 0), 'eta finite')
  assertEqual(calls[5][2], 0)
})
test('process: step shares array references', async () => {
  const r = await processClip(fakeSource(6), fakeDetector(), { step: 2 })
  assert(r.detections[1] === r.detections[0], 'frame 1 reuses frame 0 array')
  assert(r.detections[3] === r.detections[2], 'frame 3 reuses frame 2 array')
  assert(r.detections[2] !== r.detections[0], 'frame 2 is freshly detected')
  assertEqual(r.times[1], 1 / 30)
})
test('process: onProgress throw does not reject', async () => {
  const warn = console.warn, warns = []
  console.warn = (...a) => warns.push(a)
  try {
    const src = fakeSource(5)
    const r = await processClip(src, fakeDetector(), { onProgress: () => { throw new Error('ui bug') } })
    assertEqual([r.completed, r.lastFrame, 'error' in r], [true, 4, false])
    assertEqual(warns.length, 1)
  } finally { console.warn = warn }
})
test('process: source.stop throw does not reject', async () => {
  const src = fakeSource(3)
  src.stop = () => { throw new Error('stop failed') }
  const warn = console.warn
  console.warn = () => {}
  try { assertEqual((await processClip(src, fakeDetector(), {})).completed, true) } finally { console.warn = warn }
})

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

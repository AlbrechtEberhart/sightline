import { test, assertEqual, assertClose, skip, fixture } from './harness.js'
import { exportClip } from '../recorded/yolo/export.js'
import { processClip } from '../recorded/yolo/process.js'
import { FileVideoSource } from '../recorded/video-source.js'
import { createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
const run = async name => {
  const blob = await fixture(name), det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
  const { detections } = await processClip(await FileVideoSource.open(blob), det, { step: 2 })
  try { return await FileVideoSource.open(await exportClip(blob, detections)) }
  catch (e) { if (e.name === 'EncoderUnsupportedError') skip('H.264 encoding unavailable'); throw e }
}
test('recorded-yolo: exportClip keeps frames, duration, audio', async () => {
  const out = await run('bus-3s.mp4')
  assertEqual([out.meta.frameCount, out.meta.hasAudio], [90, true]); assertClose(out.meta.duration, 3.0, 0.034)
})
test('recorded-yolo: exportClip without audio', async () => {
  const out = await run('bus-3s-noaudio.mp4'); assertEqual([out.meta.frameCount, out.meta.hasAudio], [90, false])
})

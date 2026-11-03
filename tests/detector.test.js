import { test, assert, assertEqual, assertClose, fixtureImage } from './harness.js'
import { preprocess, postprocess, createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
import { letterbox } from '../core/detect/letterbox.js'
import { makeOutput } from './fixtures/yolo-output.js'
test('detector: preprocess pads grey, CHW RGB', () => {
  const c = new OffscreenCanvas(4, 2), g = c.getContext('2d')
  g.fillStyle = '#f00'; g.fillRect(0, 0, 2, 2); g.fillStyle = '#00f'; g.fillRect(2, 0, 2, 2)
  const { data, lb } = preprocess(c, 4), px = (ch, y, x) => data[ch * 16 + y * 4 + x]
  assertEqual(lb.padY, 1); assertClose(px(1, 0, 0), 114 / 255, 1e-3)
  assertClose(px(0, 1, 0), 1, 1e-3); assertClose(px(2, 1, 3), 1, 1e-3); assertClose(px(0, 1, 3), 0, 1e-3)
})
test('detector: drops zero-size boxes', () => {
  // 640x320 source in a 640 input: scale 1, padY 160, so y < 160 is padding.
  const lb = letterbox(640, 320, 640)
  const out = makeOutput(10, [
    { cx: 320, cy: 30, w: 100, h: 40, scores: { 0: 0.9 } },   // fully inside the top padding band
    { cx: 320, cy: 320, w: 100, h: 100, scores: { 0: 0.8 } }, // real box
  ])
  const boxes = postprocess(out, 10, lb, 640, 320, { conf: 0.35, iou: 0.45 })
  assertEqual(boxes.length, 1)
  assertEqual(boxes[0].label, 'person')
  assert(boxes.every(b => b.box[2] > 0 && b.box[3] > 0), 'no zero-size boxes')
})
test('detector: bus.jpg @640 finds bus and person', async () => {
  const det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[640]), inputSize: 640 })
  const boxes = await det.detect(await fixtureImage('bus.jpg'))
  assert(boxes.some(b => b.label === 'bus' && b.score > 0.5), 'bus')
  assert(boxes.some(b => b.label === 'person' && b.score > 0.5), 'person')
  assert(det.warmupMs > 0); det.dispose()
})
test('detector: 320 model runs', async () => {
  const det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
  assert(Array.isArray(await det.detect(await fixtureImage('bus.jpg')))); det.dispose()
})

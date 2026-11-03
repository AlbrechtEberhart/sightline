import { test, assert, assertEqual, assertClose } from './harness.js'
import { decode } from '../core/detect/decode.js'
import { nms, iouOf } from '../core/detect/nms.js'
import { COCO_LABELS } from '../core/detect/labels.js'
import { colorFor } from '../core/detect/colors.js'
import { makeOutput } from './fixtures/yolo-output.js'
test('decode: keeps top class above conf', () => {
  const out = makeOutput(4, [
    { cx: 100, cy: 100, w: 50, h: 20, scores: { 2: 0.9 } },
    { cx: 10, cy: 10, w: 5, h: 5, scores: { 0: 0.2 } },
    { cx: 200, cy: 200, w: 40, h: 40, scores: { 5: 0.5, 7: 0.6 } },
    { cx: 0, cy: 0, w: 0, h: 0, scores: {} }])
  const r = decode(out, 4, 0.35)
  assertEqual(r.map(b => b.classId), [2, 7]); assertEqual(r[0].box, [75, 90, 50, 20]); assertClose(r[1].score, 0.6, 1e-6)
})
test('nms: iouOf', () => {
  assertClose(iouOf([0, 0, 100, 100], [0, 0, 100, 100]), 1, 1e-9)
  assertEqual(iouOf([0, 0, 10, 10], [20, 20, 10, 10]), 0)
  assertClose(iouOf([0, 0, 100, 100], [10, 10, 100, 100]), 8100 / 11900, 1e-6)
})
const b = (classId, score, box) => ({ classId, score, box })
test('nms: same class overlap suppressed', () =>
  assertEqual(nms([b(2, .8, [10, 10, 100, 100]), b(2, .9, [0, 0, 100, 100])], 0.45).map(x => x.score), [.9]))
test('nms: different classes kept', () =>
  assertEqual(nms([b(2, .9, [0, 0, 100, 100]), b(5, .8, [10, 10, 100, 100])], 0.45).length, 2))
test('nms: empty input', () => assertEqual(nms([], 0.45), []))
test('labels: 80 COCO names', () => {
  assertEqual(COCO_LABELS.length, 80); assertEqual([COCO_LABELS[0], COCO_LABELS[2], COCO_LABELS[5], COCO_LABELS[9]], ['person', 'car', 'bus', 'traffic light'])
})
test('colors: stable and distinct', () => {
  assertEqual(colorFor(2), colorFor(2)); assert(colorFor(0) !== colorFor(2)); assert(/^#[0-9a-f]{6}$/.test(colorFor(79)))
})

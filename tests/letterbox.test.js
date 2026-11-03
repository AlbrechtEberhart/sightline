import { test, assertEqual, assertClose } from './harness.js'
import { letterbox, toInput, toSource } from '../core/detect/letterbox.js'
const near = (a, b) => a.forEach((v, i) => assertClose(v, b[i], 0.5))
test('letterbox: landscape 1920x1080 @640', () => {
  const lb = letterbox(1920, 1080, 640)
  assertClose(lb.scale, 1 / 3, 1e-9); assertEqual([lb.newW, lb.newH, lb.padX, lb.padY], [640, 360, 0, 140])
})
test('letterbox: portrait 1080x1920 @320', () => {
  const lb = letterbox(1080, 1920, 320)
  assertEqual([lb.newW, lb.newH, lb.padX, lb.padY], [180, 320, 70, 0])
})
test('letterbox: square 1000x1000 @640', () => {
  const lb = letterbox(1000, 1000, 640); assertEqual([lb.padX, lb.padY], [0, 0])
})
test('letterbox: round trip within 0.5px', () => {
  for (const [w, h, s] of [[1920, 1080, 640], [1080, 1920, 320], [1000, 1000, 640]]) {
    const lb = letterbox(w, h, s), box = [100, 200, 300, 400]
    near(toSource(toInput(box, lb), lb, w, h), box)
  }
})
test('letterbox: toSource clamps to image', () => {
  const lb = letterbox(1920, 1080, 640)
  assertEqual(toSource([-10, 130, 700, 100], lb, 1920, 1080)[0], 0)
})

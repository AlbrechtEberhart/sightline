import { test, assert, assertEqual, assertClose } from './harness.js'
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
  const [x, y, w, h] = toSource([-10, 130, 700, 100], lb, 1920, 1080)
  assertEqual(x, 0)
  assert(x + w <= 1920, `right edge ${x + w} exceeds srcW 1920`)
  assert(y + h <= 1080, `bottom edge ${y + h} exceeds srcH 1080`)
})
test('letterbox: fully outside box clamps to zero size', () => {
  const lb = letterbox(1920, 1080, 640)
  const inBounds = ([x, y, w, h]) =>
    w >= 0 && h >= 0 && x >= 0 && x <= 1920 && y >= 0 && y <= 1080 && x + w <= 1920 && y + h <= 1080
  // Fully inside the top letterbox padding band (input y in [0, 140)).
  const top = toSource([100, 10, 200, 100], lb, 1920, 1080)
  assert(inBounds(top), `top band box out of bounds: ${JSON.stringify(top)}`)
  assertEqual(top[3], 0, 'top band box height')
  // Fully past the right edge of the scaled image (input x >= 640).
  const right = toSource([700, 100, 50, 50], lb, 1920, 1080)
  assert(inBounds(right), `right overflow box out of bounds: ${JSON.stringify(right)}`)
  assertEqual(right[2], 0, 'right overflow box width')
})

import { test, assert, assertClose } from './harness.js'
import { toThumb } from '../core/stitch/thumb.js'
import { sharpness } from '../core/stitch/sharpness.js'
import { phaseShift } from '../core/stitch/shift.js'

// Seeded random rectangles on a 256x144 canvas (mulberry32), so every run sees the same texture.
function texture() {
  let s = 12345
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const c = new OffscreenCanvas(256, 144)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 256, 144)
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgb(${rnd() * 255 | 0},${rnd() * 255 | 0},${rnd() * 255 | 0})`
    ctx.fillRect(rnd() * 240, rnd() * 130, 4 + rnd() * 40, 4 + rnd() * 30)
  }
  return c
}

function frame(src, dx, dy) {
  const c = new OffscreenCanvas(320, 180)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 320, 180)
  ctx.drawImage(src, 32 + dx, 18 + dy)
  return c
}

test('stitch-measure: sharpness drops when blurred', () => {
  const sharp = texture()
  const blurred = new OffscreenCanvas(256, 144)
  const ctx = blurred.getContext('2d')
  ctx.filter = 'blur(2px)'
  ctx.drawImage(sharp, 0, 0)
  const s = sharpness(toThumb(sharp))
  const b = sharpness(toThumb(blurred))
  assert(s > 0, `sharp variance ${s} should be positive`)
  assert(b < 0.5 * s, `blurred ${b} should be under half of sharp ${s}`)
})

test('stitch-measure: phaseShift recovers a known offset', () => {
  const src = texture()
  const r = phaseShift(toThumb(frame(src, 0, 0), 320), toThumb(frame(src, 12.5, -3), 320))
  assertClose(r.dx, 12.5, 0.5)
  assertClose(r.dy, -3, 0.5)
  assert(r.peak > 0.2, `peak ${r.peak} should exceed 0.2`)
})

test('stitch-measure: phaseShift on identical frames is zero', () => {
  const src = texture()
  const r = phaseShift(toThumb(frame(src, 0, 0), 320), toThumb(frame(src, 0, 0), 320))
  assert(Math.abs(r.dx) < 0.1, `dx ${r.dx} should be near 0`)
  assert(Math.abs(r.dy) < 0.1, `dy ${r.dy} should be near 0`)
})

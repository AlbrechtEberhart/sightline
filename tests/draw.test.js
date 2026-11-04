import { test, assert, assertEqual, assertClose } from './harness.js'
import { fitCover, fitContain, drawDetections, strokeScale } from '../shared/draw-boxes.js'
import { createFpsMeter, formatStatus, lowFpsHint } from '../live/yolo/status.js'
import { colorFor } from '../core/detect/colors.js'
test('draw: fitCover portrait clip on phone', () => {
  const f = fitCover(810, 1080, 390, 844); assertClose(f.scale, 844 / 1080, 1e-9); assertClose(f.offsetX, (390 - 810 * 844 / 1080) / 2, 1e-6); assertEqual(f.offsetY, 0)
})
test('draw: fitContain', () => { const f = fitContain(1920, 1080, 960, 1080); assertClose(f.scale, 0.5, 1e-9); assertEqual(f.offsetX, 0); assertClose(f.offsetY, 270, 1e-6) })
test('draw: stroke uses class colour', () => {
  const c = new OffscreenCanvas(100, 100), g = c.getContext('2d')
  drawDetections(g, [{ classId: 2, label: 'car', score: 0.86, box: [20, 40, 60, 40] }], { showLabels: false })
  const [r, gg, b] = g.getImageData(50, 40, 1, 1).data, hex = '#' + [r, gg, b].map(v => v.toString(16).padStart(2, '0')).join('')
  assertEqual(hex, colorFor(2))
})
test('draw: fps meter', () => { const m = createFpsMeter(); for (let i = 0; i <= 10; i++) m.tick(i * 100); assertEqual(Math.round(m.fps), 10) })
test('draw: formatStatus', () => {
  assertEqual(formatStatus({ count: 5, backend: 'webgpu', fps: 11.4 }), '5 objects · WebGPU · 11 fps')
  assertEqual(formatStatus({ count: 1, backend: 'wasm', fps: 3 }), '1 object · WASM · 3 fps')
})
test('draw: lowFpsHint', () => { assertEqual(lowFpsHint(5, false), null); assert(lowFpsHint(2, true).includes('Stop recording')) })
const hexAt = (g, x, y) => { const [r, gg, b] = g.getImageData(x, y, 1, 1).data; return '#' + [r, gg, b].map(v => v.toString(16).padStart(2, '0')).join('') }
test('draw: fps decays after stall', () => {
  const m = createFpsMeter(); for (let i = 0; i <= 10; i++) m.tick(i * 100)
  assertClose(m.fpsAt(1000), 10, 0.01); assertEqual(m.fpsAt(5000), 0)
})
test('draw: fps warm-up uses observed span', () => {
  const m = createFpsMeter(); m.tick(0); m.tick(100); assertClose(m.fps, 10, 0.01)
})
test('draw: dpr scales stroke not position', () => {
  const g = new OffscreenCanvas(200, 200).getContext('2d')
  drawDetections(g, [{ classId: 2, label: 'car', score: 0.86, box: [20, 40, 60, 40] }], { showLabels: false, dpr: 2 })
  const c = colorFor(2)
  assertEqual(hexAt(g, 50, 40), c); assertEqual(hexAt(g, 50, 42), c); assert(hexAt(g, 50, 46) !== c, 'stroke should not reach y=46')
})
test('draw: tag clamped inside canvas', () => {
  const g = new OffscreenCanvas(100, 100).getContext('2d')
  drawDetections(g, [{ classId: 2, label: 'car', score: 0.86, box: [90, 5, 20, 20] }], { showLabels: true })
  const c = colorFor(2)
  assertEqual(hexAt(g, 99, 8), c)
  assertEqual(hexAt(g, 80, 20), c, 'tag should be pulled left to fit the canvas')
})

test('draw: strokeScale', () => {
  assertEqual(strokeScale(390, 844), 1)
  assertEqual(strokeScale(1080, 1920), 1080 / 390)
  assertEqual(strokeScale(100, 100), 1)
})

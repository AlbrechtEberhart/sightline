import { test, assert, assertEqual, assertClose } from './harness.js'
import { fitCover, fitContain, drawDetections } from '../shared/draw-boxes.js'
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

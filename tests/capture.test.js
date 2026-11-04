import { test, assert, assertEqual, assertClose } from './harness.js'
import { createCaptureRules, maxPhotosFor } from '../core/stitch/capture.js'
import { displayedHfov } from '../core/stitch/camera-model.js'
import { createMotion } from '../live/motion.js'

const STEADY = { pitch: 0, roll: 0, rate: 20, sharpness: 100 }

// Feeds the given yaws (merged over a steady, level, sharp reading) and returns every update result.
function feed(rules, yaws, extra = {}) {
  return yaws.map(yaw => rules.update({ ...STEADY, ...extra, yaw }))
}

function range(from, to, step = 1) {
  const out = []
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) out.push(v)
  return out
}

test('capture: shoots every 0.65 hfov', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  const yaws = range(0, 60)
  const shotAt = feed(rules, yaws).map((r, i) => r.shoot ? yaws[i] : null).filter(v => v !== null)
  assertEqual(shotAt, [0, 26, 52])
  assertEqual(rules.photosYaw, [0, 26, 52])
})

test('capture: no shot when fast, warns above 40', () => {
  const slow = createCaptureRules({ hfovDeg: 40 })
  const r35 = feed(slow, range(0, 60), { rate: 35 })
  assert(r35.every(r => !r.shoot && r.warning === null), 'rate 35 neither shoots nor warns')
  const fast = createCaptureRules({ hfovDeg: 40 })
  const r45 = feed(fast, range(0, 60), { rate: 45 })
  assert(r45.every(r => !r.shoot && r.warning === 'Slow down'), 'rate 45 warns Slow down')
})

test('capture: keep level', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  const r = rules.update({ ...STEADY, yaw: 0, pitch: 9 })
  assertEqual(r.shoot, false)
  assertEqual(r.warning, 'Keep level')
  assertEqual(rules.update({ ...STEADY, yaw: 0, roll: -9 }).warning, 'Keep level')
  const edge = rules.update({ ...STEADY, yaw: 0, pitch: 8, roll: -8 })
  assertEqual(edge.shoot, true)
  assertEqual(edge.warning, null)
})

test('capture: blurry frame waits', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  const first = feed(rules, range(0, 13)) // 14 sharp frames, first one shoots at 0
  assertEqual(first[0].shoot, true)
  const blurry = rules.update({ ...STEADY, yaw: 26, sharpness: 70 })
  assertEqual(blurry.shoot, false)
  assertEqual(blurry.warning, null)
  const next = rules.update({ ...STEADY, yaw: 26, sharpness: 100 })
  assertEqual(next.shoot, true)
  assertEqual(next.count, 2)
})

test('capture: go back a little', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  assertEqual(rules.update({ ...STEADY, yaw: 0 }).shoot, true)
  const r = rules.update({ ...STEADY, yaw: 37, rate: 35 })
  assertEqual(r.shoot, false)
  assertEqual(r.warning, 'Go back a little')
  assertEqual(r.direction, 1)
})

test('capture: warning priority and exclusivity', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  rules.update({ ...STEADY, yaw: 0 })
  const r = rules.update({ ...STEADY, yaw: 37, rate: 45, pitch: 12 })
  assertEqual(r.warning, 'Slow down')
  const r2 = rules.update({ ...STEADY, yaw: 37, rate: 35, pitch: 12 })
  assertEqual(r2.warning, 'Keep level')
  const r3 = rules.update({ ...STEADY, yaw: 26 })
  assertEqual(r3.shoot, true)
  assertEqual(r3.warning, null)
})

test('capture: reversing does not shoot', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  const out = feed(rules, range(0, 30))
  assertEqual(out.filter(r => r.shoot).length, 2)
  const back = feed(rules, range(29, 0, -1))
  assert(back.every(r => !r.shoot), 'no shot while reversing')
  assertEqual(back[back.length - 1].direction, 1)
  assertEqual(rules.photosYaw, [0, 26])
})

test('capture: sweeping left sets direction -1', () => {
  const rules = createCaptureRules({ hfovDeg: 40 })
  const yaws = range(0, -60, -1)
  const out = feed(rules, yaws)
  assertEqual(out[out.length - 1].direction, -1)
  assertEqual(rules.photosYaw, [0, -26, -52])
})

test('capture: done at 12', () => {
  const rules = createCaptureRules({ hfovDeg: 40, maxSweepDeg: 1000 }) // only the photo cap applies
  const out = feed(rules, range(0, 400))
  assertEqual(out.filter(r => r.shoot).length, 12)
  const last = out.find(r => r.count === 12)
  assertEqual(last.done, true)
  assertEqual(last.shoot, true)
  const after = out.slice(out.indexOf(last) + 1)
  assert(after.every(r => !r.shoot && r.done && r.warning === null && r.count === 12), 'nothing after done')
  assertEqual(rules.photosYaw.length, 12)
})

test('capture: sweep cap stops before the next shot would pass it', () => {
  const rules = createCaptureRules({ hfovDeg: 40, maxSweepDeg: 200 })
  const out = feed(rules, range(0, 300))
  // A shot is allowed while |yaw| + 40 <= 200: 0, 26, ..., 156. The next one (182) would pass it, so done at 156.
  assertEqual(rules.photosYaw, [0, 26, 52, 78, 104, 130, 156])
  const last = out.find(r => r.count === 7)
  assertEqual([last.shoot, last.done], [true, true])
  const after = out.slice(out.indexOf(last) + 1)
  assert(after.every(r => !r.shoot && r.done && r.count === 7), 'nothing after done')
})

test('capture: a due shot past the sweep cap ends capture without shooting', () => {
  const rules = createCaptureRules({ hfovDeg: 40, maxSweepDeg: 200 })
  feed(rules, range(0, 130)) // shots at 0..130; the next (156 + 40 = 196) still fits
  assertEqual(rules.photosYaw, [0, 26, 52, 78, 104, 130])
  const tilted = feed(rules, range(131, 160), { pitch: 12 }) // not level: due from 156, but no shot
  assert(tilted.every(r => !r.shoot && !r.done), 'no shot while tilted')
  const r = rules.update({ ...STEADY, yaw: 171 }) // 171 + 40 > 200
  assertEqual([r.shoot, r.done, r.count], [false, true, 6])
})

test('capture: sweep cap applies to a leftward sweep', () => {
  const rules = createCaptureRules({ hfovDeg: 40, maxSweepDeg: 200 })
  const out = feed(rules, range(0, -300, -1))
  assertEqual(rules.photosYaw, [0, -26, -52, -78, -104, -130, -156])
  assertEqual(out[out.length - 1].done, true)
})

// Wrapped yaws (as motion.js reports them) past 180 degrees: the rules unwrap them.
const wrap180 = (d) => { const w = ((d % 360) + 360) % 360; return w > 180 ? w - 360 : w }

test('capture: wrapped yaws past 180 keep shooting (landscape Wide)', () => {
  const hfovDeg = displayedHfov({ lens: 'wide', width: 640, height: 360 })
  const rules = createCaptureRules({ hfovDeg, maxPhotos: maxPhotosFor(hfovDeg), maxSweepDeg: 335 })
  const out = feed(rules, range(0, 340).map(wrap180))
  assertEqual(rules.photosYaw, [0, 44, 88, 132, 176, 220, 264])
  assertEqual(out.at(-1).done, true)
})

test('capture: upright Wide sweep from real motion events passes 180 and stops', () => {
  const win = new EventTarget(), motion = createMotion(win)
  motion.start()
  const hfovDeg = displayedHfov({ lens: 'wide', width: 360, height: 640 })
  const rules = createCaptureRules({ hfovDeg, maxPhotos: maxPhotosFor(hfovDeg), maxSweepDeg: 335 })
  let last = null
  try {
    win.dispatchEvent(Object.assign(new Event('devicemotion'), { rotationRate: { alpha: 0, beta: 20, gamma: 0 } }))
    for (let turn = 0; turn <= 340; turn++) {
      // Upright (beta 90), turning right: alpha falls.
      win.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha: (360 - turn) % 360, beta: 90, gamma: 0 }))
      if (turn === 0) motion.zero()
      last = rules.update({ ...motion.reading(), sharpness: 100 })
    }
  } finally {
    motion.stop()
  }
  const yaws = rules.photosYaw
  // Step 0.65 x 40.8 = 26.5 degrees, taken at the next whole degree: 0, 27, ..., 270. The 12th (297) would end past
  // 335 - 40.8, so capture is done at 11 photos.
  assertEqual(yaws.length, 11)
  assertEqual(last.done, true)
  assert(yaws.every((y, i) => i === 0 || y > yaws[i - 1]), `monotonic: ${yaws.map(y => y.toFixed(1))}`)
  assert(yaws.at(-1) > 180, `last shot at ${yaws.at(-1)}`)
  yaws.forEach((y, i) => assertClose(y, 27 * i, 0.01))
})

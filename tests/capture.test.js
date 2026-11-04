import { test, assert, assertEqual } from './harness.js'
import { createCaptureRules } from '../core/stitch/capture.js'

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
  const rules = createCaptureRules({ hfovDeg: 40 })
  const out = feed(rules, range(0, 400))
  assertEqual(out.filter(r => r.shoot).length, 12)
  const last = out.find(r => r.count === 12)
  assertEqual(last.done, true)
  assertEqual(last.shoot, true)
  const after = out.slice(out.indexOf(last) + 1)
  assert(after.every(r => !r.shoot && r.done && r.warning === null && r.count === 12), 'nothing after done')
  assertEqual(rules.photosYaw.length, 12)
})

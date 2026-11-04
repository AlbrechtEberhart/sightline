import { test, assert, assertEqual } from './harness.js'
import { createFramePicker } from '../core/stitch/select.js'

const W = 1000

// n frames of constant dx (0 for the first), sharpness 1 except 10 at each peak index. `overrides` maps index -> {dx, sharpness}.
function frames(n, dx, peaks = [], overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    index: i, dx: i === 0 ? 0 : dx, sharpness: peaks.includes(i) ? 10 : 1, ...overrides[i],
  }))
}

// Pushes every frame, tracking which bitmaps the caller would hold. Returns everything the caller can observe.
function run(list, opts = {}) {
  const picker = createFramePicker({ width: W, ...opts })
  const held = new Set()
  const picks = []
  const results = []
  let maxHeld = 0
  for (const f of list) {
    const r = picker.push(f)
    if (r.hold) held.add(f.index)
    for (const i of r.release) held.delete(i)
    if (r.pick !== null) {
      picks.push(r.pick)
      held.delete(r.pick) // the caller hands a picked frame to the stitcher and stops holding it
    }
    maxHeld = Math.max(maxHeld, held.size)
    results.push(r)
  }
  const fin = picker.finish()
  picks.push(...fin.picks)
  for (const i of fin.picks) held.delete(i)
  for (const i of fin.release) held.delete(i)
  return { picks, fin, held, maxHeld, results }
}

test('select: picks sharpest near each target', () => {
  const { picks, fin } = run(frames(200, 10, [3, 66, 129]))
  assertEqual(picks.slice(0, 3), [3, 66, 129])
  assertEqual(fin.error, null)
  assertEqual(picks.length, 4) // finish adds a last pick: 300+ px followed the last pick
  assertEqual(fin.picks, [picks[3]])
})

test('select: leftward pan picks the same spacing', () => {
  const { picks, fin } = run(frames(200, -10, [3, 66, 129]))
  assertEqual(picks.slice(0, 3), [3, 66, 129])
  assertEqual(picks, run(frames(200, 10, [3, 66, 129])).picks)
  assertEqual(fin.error, null)
})

test('select: holds only window frames', () => {
  const { maxHeld, held, results } = run(frames(200, 10, [3, 66, 129]))
  const limit = Math.ceil(0.2 * W / 10) + 1
  assert(maxHeld >= 1, 'something is held')
  assert(maxHeld <= limit, `held ${maxHeld} frames at once, limit ${limit}`)
  assertEqual(held.size, 0)
  assert(results.some(r => r.hold === false), 'frames that are not needed are not held')
})

test('select: skipped window takes the first frame past it', () => {
  const list = [
    { index: 0, dx: 0, sharpness: 1 },
    { index: 1, dx: 70, sharpness: 1 },
    { index: 2, dx: 50, sharpness: 1 }, // s = 120: window 0 closes, picks 0
    { index: 3, dx: 400, sharpness: 5 }, // s = 520: between windows, held as tail
    { index: 4, dx: 400, sharpness: 1 }, // s = 920: window 1 (550..750) never saw a frame
  ]
  const { results, picks, held } = run(list)
  assertEqual(results[2].pick, 0)
  assertEqual(results[3], { hold: true, release: [2], pick: null }) // sharper than frame 2, the tail so far
  assertEqual(results[4], { hold: true, release: [3], pick: 4 })
  assertEqual(picks, [0, 4])
  assertEqual(held.size, 0)
})

test('select: pan was fast', () => {
  const { fin } = run(frames(200, 10, [], { 50: { dx: 160 } }))
  assert(fin.messages.includes('Pan was fast'), 'fast message present')
  assert(!run(frames(200, 10)).fin.messages.includes('Pan was fast'), 'no fast message on a steady pan')
  assert(!run(frames(200, 10, [], { 50: { dx: 150 } })).fin.messages.includes('Pan was fast'), '0.15 W exactly is not fast')
})

test('select: not enough panning', () => {
  const { fin, held } = run(frames(100, 4))
  assertEqual(fin.error, 'Not enough panning')
  assertEqual(fin.picks, [])
  assertEqual(held.size, 0)
})

test('select: caps at 12', () => {
  const { picks, fin, results, held } = run(frames(1200, 10))
  assertEqual(picks.length, 12)
  assertEqual(held.size, 0)
  assertEqual(fin.picks, [])
  assert(fin.messages.includes('Used the first 12 frames of the pan'), 'cap message present')
  const capPush = results.findIndex(r => r.pick === picks[11]) // the push that made the 12th pick final
  assert(results.slice(capPush + 1).length > 0, 'frames follow the cap')
  assert(results.slice(capPush + 1).every(r => !r.hold && r.pick === null && r.release.length === 0), 'later frames are not held')
  assert(!run(frames(200, 10)).fin.messages.some(m => m.startsWith('Used the first')), 'no cap message below the cap')
})

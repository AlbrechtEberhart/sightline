import { test, assert, assertEqual } from './harness.js'
import { fetchAsset, OPENCV_ASSET } from '../shared/models.js'
import { focalPx } from '../core/stitch/camera-model.js'
import { Stitcher } from '../core/stitch/stitcher.js'
import { makeScene, renderView } from './fixtures/synthetic-pan.js'

const W = 640, H = 360
const F = focalPx({ lens: 'wide', width: W, height: H })
const TRUTH = [0, 26, 52, 78, 104]

// One download (or cache read) of the OpenCV bytes per test file; Stitcher.create transfers a copy.
let bytesPromise = null
const opencvBytes = () => (bytesPromise ??= fetchAsset(OPENCV_ASSET.url, OPENCV_ASSET))

let scenePromise = null
const scene = () => (scenePromise ??= Promise.resolve(makeScene({ f: F })))

async function view(yawDeg, opts = {}) {
  return createImageBitmap(renderView(await scene(), { yawDeg, pitchDeg: 2, width: W, height: H, ...opts }))
}

function greyFrame() {
  const c = new OffscreenCanvas(W, H)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, W, H)
  return createImageBitmap(c)
}

async function stitcher(mode, onProgress) {
  return Stitcher.create({ opencvBytes: await opencvBytes(), focalPx: F, width: W, height: H, mode, onProgress })
}

test('stitcher: yaws within 0.3 degrees', async () => {
  const progress = []
  const s = await stitcher('studio', (stage, done, total) => progress.push([stage, done, total]))
  for (const yaw of TRUTH) s.add(await view(yaw))
  const r = await s.finish()
  assertEqual(r.used, 5)
  assertEqual(r.blob, null)
  assertEqual(r.notes, [])
  assertEqual(r.yaws.length, 5)
  r.yaws.forEach((y, i) => assert(Math.abs(y - TRUTH[i]) < 0.3, `yaw ${i}: ${y} vs ${TRUTH[i]}`))
  r.rolls.forEach((roll, i) => assert(Math.abs(roll) < 0.5, `roll ${i}: ${roll}`))
  assertEqual(progress.at(-1), ['match', 4, 4])
})

test('stitcher: featureless pair fails in studio', async () => {
  const s = await stitcher('studio')
  for (const yaw of TRUTH.slice(0, 3)) s.add(await view(yaw))
  s.add(await greyFrame())
  const r = await s.finish()
  assertEqual(r.used, 3)
  assertEqual(r.notes, ["Stitched frames 1–3; frame 4 didn't match."])
  assertEqual(r.yaws.length, 3)
})

test('stitcher: featureless pair uses gyro in live', async () => {
  const s = await stitcher('live')
  for (const yaw of TRUTH.slice(0, 3)) s.add(await view(yaw), { yawHint: yaw })
  s.add(await greyFrame(), { yawHint: TRUTH[3] })
  const r = await s.finish()
  assertEqual(r.used, 4)
  assertEqual(r.notes, ['One seam was placed from the gyroscope and may be visible'])
  assert(Math.abs(r.yaws[3] - TRUTH[3]) < 0.5, `gyro yaw ${r.yaws[3]}`)
})

test('stitcher: first pair failing in studio rejects with StitchError', async () => {
  const s = await stitcher('studio')
  s.add(await view(0))
  s.add(await greyFrame())
  let err = null
  try { await s.finish() } catch (e) { err = e }
  assert(err, 'finish should reject')
  assertEqual(err.name, 'StitchError')
})

test('stitcher: cancel rejects with AbortError', async () => {
  const s = await stitcher('studio')
  s.add(await view(0))
  s.cancel()
  let err = null
  try { await s.finish() } catch (e) { err = e }
  assert(err, 'finish should reject')
  assertEqual(err.name, 'AbortError')
  const late = await view(26)
  s.add(late)
  assertEqual(late.width, 0, 'add after cancel closes the bitmap')
})

test('stitcher: synthetic fixture is deterministic', async () => {
  const a = renderView(await scene(), { yawDeg: 13, pitchDeg: 2, rollDeg: 1, width: 160, height: 90 })
  const b = renderView(makeScene({ f: F }), { yawDeg: 13, pitchDeg: 2, rollDeg: 1, width: 160, height: 90 })
  const pa = a.getContext('2d').getImageData(0, 0, 160, 90).data
  const pb = b.getContext('2d').getImageData(0, 0, 160, 90).data
  assertEqual(pa, pb)
  let sum = 0
  for (let i = 0; i < pa.length; i += 4) sum += pa[i]
  assert(sum > 0, 'view is not blank')
})

import { test, assert, assertEqual } from './harness.js'
import { fetchAsset, OPENCV_ASSET } from '../shared/models.js'
import { focalPx } from '../core/stitch/camera-model.js'
import { Stitcher } from '../core/stitch/stitcher.js'
import { makeScene, renderView } from './fixtures/synthetic-pan.js'
import { toThumb } from '../core/stitch/thumb.js'
import { phaseShift } from '../core/stitch/shift.js'
import { cylBounds, mul, rotX, rotY } from '../core/stitch/geometry.js'

const W = 640, H = 360
const F = focalPx({ lens: 'wide', width: W, height: H })
const TRUTH = [0, 26, 52, 78, 104]
const PITCH = 2
const RAD = Math.PI / 180
const STRIP = 256

// One download (or cache read) of the OpenCV bytes per test file; Stitcher.create transfers a copy.
let bytesPromise = null
const opencvBytes = () => (bytesPromise ??= fetchAsset(OPENCV_ASSET.url, OPENCV_ASSET))

let scenePromise = null
const scene = () => (scenePromise ??= Promise.resolve(makeScene({ f: F })))

async function view(yawDeg, opts = {}) {
  return createImageBitmap(renderView(await scene(), { yawDeg, pitchDeg: PITCH, width: W, height: H, ...opts }))
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

// The 5 TRUTH views, one brightness each, stitched in studio mode.
async function stitchViews(brightness = [1, 1, 1, 1, 1]) {
  const s = await stitcher('studio')
  for (const [i, yaw] of TRUTH.entries()) s.add(await view(yaw, { brightness: brightness[i] }))
  return s.finish()
}

let plainPromise = null
const plainStitch = () => (plainPromise ??= stitchViews())

async function greyOf(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    return toThumb(bitmap, bitmap.width)
  } finally {
    bitmap.close()
  }
}

function greyCrop(img, x0, y0, width, height) {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const o = (y0 + y) * img.width + x0
    data.set(img.data.subarray(o, o + width), y * width)
  }
  return { data, width, height }
}

function bilinear(img, x, y) {
  x = Math.min(img.width - 1, Math.max(0, x))
  y = Math.min(img.height - 1, Math.max(0, y))
  const x0 = Math.min(img.width - 2, Math.floor(x)), y0 = Math.min(img.height - 2, Math.floor(y))
  const ax = x - x0, ay = y - y0, d = img.data, i = y0 * img.width + x0
  const top = d[i] + ax * (d[i + 1] - d[i])
  const bottom = d[i + img.width] + ax * (d[i + img.width + 1] - d[i + img.width])
  return top + ay * (bottom - top)
}

// Mean absolute grey difference between output columns [c0, c1) and the scene. The output and the scene share the
// cylinder parametrisation (same f, output scale 1 at this size), so the output is a translation of the scene: the
// recentred middle (yaw 52°, the horizon pitched up by PITCH) gives a first guess for a STRIP-wide crop around the
// columns, and phase correlation against the scene refines it.
let sceneGreyCache = null

async function sceneDiff(out, c0, c1) {
  const { u0, v0, canvas } = await scene()
  const sceneGrey = (sceneGreyCache ??= toThumb(canvas, canvas.width))
  const h = out.height
  const x0 = Math.max(0, Math.min(out.width - STRIP, Math.round((c0 + c1 - STRIP) / 2)))
  const gx = Math.round(u0 + 52 * RAD * F + x0 - out.width / 2)
  const gy = Math.round(v0 - F * Math.tan(PITCH * RAD) - h / 2)
  const { dx, dy } = phaseShift(greyCrop(sceneGrey, gx, gy, STRIP, h), greyCrop(out, x0, 0, STRIP, h))
  let sum = 0
  for (let y = 0; y < h; y++) {
    for (let x = c0; x < c1; x++) sum += Math.abs(out.data[y * out.width + x] - bilinear(sceneGrey, gx + x - x0 - dx, gy + y - dy))
  }
  return sum / (h * (c1 - c0))
}

test('stitcher: yaws within 0.3 degrees', async () => {
  const progress = []
  const s = await stitcher('studio', (stage, done, total) => progress.push([stage, done, total]))
  for (const yaw of TRUTH) s.add(await view(yaw))
  const r = await s.finish()
  assertEqual(r.used, 5)
  assert(r.blob instanceof Blob, 'blob is a Blob')
  assertEqual(r.blob.type, 'image/jpeg')
  assertEqual(r.notes, [])
  assertEqual(r.yaws.length, 5)
  r.yaws.forEach((y, i) => assert(Math.abs(y - TRUTH[i]) < 0.3, `yaw ${i}: ${y} vs ${TRUTH[i]}`))
  r.rolls.forEach((roll, i) => assert(Math.abs(roll) < 0.5, `roll ${i}: ${roll}`))
  assertEqual(progress.filter(([stage]) => stage === 'match').at(-1), ['match', 4, 4])
  assertEqual(progress.filter(([stage]) => stage === 'warp'), [1, 2, 3, 4, 5].map((k) => ['warp', k, 5]))
  assertEqual(progress.slice(-2), [['blend', 1, 1], ['encode', 1, 1]])
})

test('stitcher: output matches the scene', async () => {
  const r = await plainStitch()
  const bitmap = await createImageBitmap(r.blob)
  assertEqual([bitmap.width, bitmap.height], [r.width, r.height])
  bitmap.close()
  const expected = F * 104 * RAD + W * 0.9
  assert(Math.abs(r.width - expected) < 0.05 * expected, `width ${r.width} vs ${expected.toFixed(0)}`)
  assert(r.height > 0.8 * H, `height ${r.height}`)
  const out = await greyOf(r.blob)
  const mid = Math.round(out.width / 2)
  const diff = await sceneDiff(out, mid - STRIP / 2, mid + STRIP / 2)
  assert(diff < 12, `mean abs grey difference ${diff.toFixed(2)}`)
  // The worker's first strip ends at grid column 1024. The grid is the uncropped cylinder at scale 1, and the crop
  // trims about the same from each end, so that column is about 1024 - (gridWidth - width) / 2 in the output.
  const b = cylBounds(TRUTH.map((yaw) => mul(rotY(yaw - 52), rotX(PITCH))), F, W, H)
  const boundary = 1024 - Math.round((Math.ceil(b.uMax - b.uMin) - r.width) / 2)
  const strip = await sceneDiff(out, boundary - 16, boundary + 17)
  assert(strip < 12, `strip boundary at column ${boundary}: mean abs grey difference ${strip.toFixed(2)}`)
})

// Output column of the cylinder point at yaw (degrees): the output is centred on the recentred middle, yaw 52.
const columnAt = (out, yaw) => Math.round(out.width / 2 + (yaw - 52) * RAD * F)

test('stitcher: alternating brightness still blends', async () => {
  const r = await stitchViews([1, 0.8, 1, 0.8, 1])
  const out = await greyOf(r.blob)
  for (let k = 0; k + 1 < TRUTH.length; k++) {
    const seam = columnAt(out, (TRUTH[k] + TRUTH[k + 1]) / 2)
    const diff = await sceneDiff(out, seam - 8, seam + 9)
    assert(diff < 12, `seam ${k}–${k + 1} at column ${seam}: mean abs grey difference ${diff.toFixed(2)}`)
  }
  // Whole-strip bands: without gain compensation these differ by about 15 grey levels.
  for (const [name, yaw] of [['middle', 52], ['dim view 1', TRUTH[1]], ['dim view 3', TRUTH[3]]]) {
    const c = columnAt(out, yaw)
    const diff = await sceneDiff(out, c - STRIP / 2, c + STRIP / 2)
    assert(diff < 12, `${name} at column ${c}: mean abs grey difference ${diff.toFixed(2)}`)
  }
})

test('stitcher: sweep is capped at about 340 degrees', async () => {
  const wide = makeScene({ f: F, yawRange: [-60, 300] }) // a full turn, so the views wrap around
  const yaws = Array.from({ length: 9 }, (_, i) => 43 * i)
  const s = await stitcher('studio')
  for (const yawDeg of yaws) {
    s.add(await createImageBitmap(renderView(wide, { yawDeg, pitchDeg: PITCH, width: W, height: H })))
  }
  const r = await s.finish()
  const hfov = 2 * Math.atan(W / 2 / F) / RAD
  // Photo k is kept while 43·k + hfov <= 340: k <= 6.
  assertEqual(r.used, 7)
  assert(43 * (r.used - 1) + hfov <= 340 && 43 * r.used + hfov > 340, `used ${r.used}, hfov ${hfov.toFixed(1)}`)
  assertEqual(r.notes, ['Used the first 7 photos (the panorama is limited to about 340°)'])
  assertEqual(r.yaws.length, 7)
  const bitmap = await createImageBitmap(r.blob)
  assertEqual([bitmap.width, bitmap.height], [r.width, r.height])
  bitmap.close()
  assert(r.width > 0 && r.width < F * 340 * RAD, `width ${r.width}`)
})

test('stitcher: output is capped at 16 MP', async () => {
  const r = await plainStitch()
  assert(r.width > 0 && r.height > 0, `size ${r.width}x${r.height}`)
  assert(r.width * r.height <= 16e6, `area ${r.width * r.height}`)
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

test('stitcher: upright (portrait) views in live mode', async () => {
  const PW = 360, PH = 640
  const f = focalPx({ lens: 'wide', width: PW, height: PH })
  const tall = makeScene({ f, height: Math.round(2 * f * Math.tan(40 * RAD)) }) // covers the 67 degree vertical view
  const yaws = [0, 26, 52, 78]
  const s = await Stitcher.create({ opencvBytes: await opencvBytes(), focalPx: f, width: PW, height: PH, mode: 'live' })
  for (const yawDeg of yaws) {
    s.add(await createImageBitmap(renderView(tall, { yawDeg, pitchDeg: PITCH, width: PW, height: PH })), { yawHint: yawDeg })
  }
  const r = await s.finish()
  assertEqual(r.used, 4)
  assertEqual(r.notes, [])
  r.yaws.forEach((y, i) => assert(Math.abs(y - yaws[i]) < 0.3, `yaw ${i}: ${y} vs ${yaws[i]}`))
})

test('stitcher: leftward sweep in studio mode', async () => {
  const left = makeScene({ f: F, yawRange: [-170, 50] })
  const yaws = [0, -40, -80, -120]
  const s = await stitcher('studio')
  for (const yawDeg of yaws) s.add(await createImageBitmap(renderView(left, { yawDeg, pitchDeg: PITCH, width: W, height: H })))
  const r = await s.finish()
  assertEqual(r.used, 4)
  assertEqual(r.notes, [])
  r.yaws.forEach((y, i) => assert(Math.abs(y - yaws[i]) < 0.3, `yaw ${i}: ${y} vs ${yaws[i]}`))
})

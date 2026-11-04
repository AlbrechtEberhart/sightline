import { test, assert, assertEqual, assertClose } from './harness.js'
import { LENS_HFOV, focalPx, displayedHfov } from '../core/stitch/camera-model.js'
import {
  rotX, rotY, rotZ, mul, transpose, apply, intrinsics, nearestRotation, rotationFromHomography,
  yawPitchRoll, chain, waveCorrect, recentre, focalFromHomographies, cylProject, cylToImage, cylBounds,
  outputScale, cropRect,
} from '../core/stitch/geometry.js'

const DEG = Math.PI / 180

function assertMatClose(a, b, tol) {
  for (let i = 0; i < 9; i++) assertClose(a[i], b[i], tol)
}

// H = K R K^-1, with K^-1 written as intrinsics(1/f, -cx/f, -cy/f).
function homographyOf(R, f, cx, cy) {
  return mul(intrinsics(f, cx, cy), mul(R, intrinsics(1 / f, -cx / f, -cy / f)))
}

function det(a) {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
}

test('camera-model: focal from field of view', () => {
  const f = focalPx({ lens: 'wide', width: 1920, height: 1080 })
  assertClose(f, 960 / Math.tan(33.5 * DEG), 0.01)
  assertClose(focalPx({ lens: 'wide', width: 1920, height: 1080, zoom: 2 }), 2 * f, 1e-9)
  assertClose(focalPx({ lens: 'ultrawide', width: 1920, height: 1080 }), 960 / Math.tan(53 * DEG), 0.01)
  assertEqual(LENS_HFOV, { wide: 67, ultrawide: 106 })
})

test('camera-model: portrait uses long side', () => {
  assertClose(
    focalPx({ lens: 'wide', width: 1080, height: 1920 }),
    focalPx({ lens: 'wide', width: 1920, height: 1080 }),
    1e-9,
  )
})

test('camera-model: displayed hfov follows orientation', () => {
  assertClose(displayedHfov({ lens: 'wide', width: 1920, height: 1080 }), 67, 0.01)
  // Upright: 2*atan((1080/1920) * tan(33.5deg)) = 40.84 degrees (the brief's "about 41").
  const upright = displayedHfov({ lens: 'wide', width: 1080, height: 1920 })
  assertClose(upright, 2 * Math.atan(0.5625 * Math.tan(33.5 * DEG)) / DEG, 1e-9)
  assertClose(upright, 41, 0.3)
  // Zoom divides through the tangent, not the angle.
  assertClose(displayedHfov({ lens: 'wide', width: 1920, height: 1080, zoom: 2 }), 2 * Math.atan(Math.tan(33.5 * DEG) / 2) / DEG, 1e-9)
  let threw = false
  try { focalPx({ lens: 'tele', width: 10, height: 10 }) } catch { threw = true }
  assert(threw, 'unknown lens should throw')
})

test('geometry: rotation sign conventions', () => {
  // y points down: rotY(+) turns the forward ray right, rotX(+) turns it up.
  const right = apply(rotY(30), [0, 0, 1])
  assert(right[0] > 0.49 && right[0] < 0.51, 'yaw right gives +x')
  const up = apply(rotX(30), [0, 0, 1])
  assert(up[1] < -0.49 && up[1] > -0.51, 'pitch up gives -y')
  assertMatClose(mul(rotZ(10), transpose(rotZ(10))), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12)
  const a = yawPitchRoll(mul(rotY(30), mul(rotX(10), rotZ(5))))
  assertClose(a.yaw, 30, 1e-9)
  assertClose(a.pitch, 10, 1e-9)
  assertClose(a.roll, 5, 1e-9)
  const b = yawPitchRoll(mul(rotY(-70), mul(rotX(-25), rotZ(-12))))
  assertClose(b.yaw, -70, 1e-9)
  assertClose(b.pitch, -25, 1e-9)
  assertClose(b.roll, -12, 1e-9)
})

test('geometry: homography round trip', () => {
  const R = mul(rotY(20), mul(rotX(3), rotZ(1)))
  const H = homographyOf(R, 500, 320, 180)
  assertMatClose(rotationFromHomography(H, 500, 320, 180), R, 1e-6)
  // H is only defined up to scale: a positive and a negative multiple give the same rotation.
  assertMatClose(rotationFromHomography(H.map((v) => v * 3.7), 500, 320, 180), R, 1e-6)
  assertMatClose(rotationFromHomography(H.map((v) => -v * 0.4), 500, 320, 180), R, 1e-6)
})

test('geometry: nearestRotation repairs a noisy matrix', () => {
  let s = 99
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5 }
  const R = mul(rotY(35), mul(rotX(-12), rotZ(7)))
  const noisy = R.map((v) => v + 0.02 * rnd())
  const N = nearestRotation(noisy)
  assertClose(det(N), 1, 1e-9)
  assertMatClose(mul(transpose(N), N), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9)
  assertMatClose(N, R, 0.05)
  // A reflection is mapped to a proper rotation too.
  const reflected = nearestRotation([1, 0, 0, 0, 1, 0, 0, 0, -1])
  assertClose(det(reflected), 1, 1e-9)
  // Scale does not matter.
  assertMatClose(nearestRotation(R.map((v) => v * 5)), R, 1e-9)
})

test('geometry: chain and yaw', () => {
  const Rs = chain([rotY(-20), rotY(-20)])
  assertEqual(Rs.length, 3)
  const yaws = Rs.map((R) => yawPitchRoll(R).yaw)
  assertClose(yaws[0], 0, 1e-9)
  assertClose(yaws[1], 20, 1e-9)
  assertClose(yaws[2], 40, 1e-9)
  assertEqual(chain([]).length, 1)
})

test('geometry: waveCorrect levels a tilted chain', () => {
  const tilt = mul(rotZ(4), rotX(2))
  const tilted = [0, 20, 40, 60].map((yaw) => mul(tilt, rotY(yaw)))
  const fixed = waveCorrect(tilted)
  assertEqual(fixed.length, 4)
  const angles = fixed.map(yawPitchRoll)
  for (const a of angles) {
    assert(Math.abs(a.roll) < 0.05, `roll ${a.roll}`)
    assertClose(a.pitch, angles[0].pitch, 0.05)
  }
  // Yaw steps between neighbours are preserved.
  assertClose(angles[1].yaw - angles[0].yaw, 20, 1e-6)
  assertClose(angles[3].yaw - angles[2].yaw, 20, 1e-6)
  // An already level chain keeps its yaws, and a sign-flipped (upside-down eigenvector) case still levels.
  const level = waveCorrect([0, 30, 60].map((yaw) => rotY(yaw)))
  assertClose(yawPitchRoll(level[2]).yaw - yawPitchRoll(level[0]).yaw, 60, 1e-6)
  const upsideDown = waveCorrect([0, 20, 40].map((yaw) => mul(rotZ(180), rotY(yaw))))
  for (const R of upsideDown) {
    const a = yawPitchRoll(R)
    assert(Math.abs(a.roll) < 0.05, `roll ${a.roll}`)
  }
})

test('geometry: cylinder round trip', () => {
  const R = mul(rotY(30), mul(rotX(-8), rotZ(2)))
  const f = 500, cx = 320, cy = 180
  for (const [x, y] of [[0, 0], [320, 180], [639, 359], [100, 300], [550, 40]]) {
    const [u, v] = cylProject(R, f, x, y, cx, cy)
    const back = cylToImage(R, f, u, v, cx, cy)
    assert(back !== null, 'point should be in front')
    assertClose(back[0], x, 1e-6)
    assertClose(back[1], y, 1e-6)
  }
  // The optical axis of a camera yawed by 30 degrees lands at u = f * 30deg.
  const [u0, v0] = cylProject(rotY(30), f, cx, cy, cx, cy)
  assertClose(u0, f * 30 * DEG, 1e-9)
  assertClose(v0, 0, 1e-9)
  // A ray behind the camera has no pixel.
  assertEqual(cylToImage(R, f, 180 * DEG * f, 0, cx, cy), null)
})

test('geometry: focal from homographies', () => {
  const f = 480, cx = 320, cy = 180
  const Hs = [15, 18, 22].map((a) => homographyOf(mul(rotY(a), rotX(a / 2)), f, cx, cy))
  const est = focalFromHomographies(Hs, 640, 360)
  assert(est !== null, 'estimate should exist')
  assert(Math.abs(est - f) / f < 0.01, `focal ${est}`)
  assertEqual(focalFromHomographies([], 640, 360), null)
  // Scale of H does not matter.
  const scaled = focalFromHomographies(Hs.map((H) => H.map((v) => v * 2.5)), 640, 360)
  assert(Math.abs(scaled - f) / f < 0.01, `scaled focal ${scaled}`)
})

test('geometry: cylBounds covers the photos', () => {
  const f = 500
  const one = cylBounds([[1, 0, 0, 0, 1, 0, 0, 0, 1]], f, 640, 360)
  assertClose(one.uMax, f * Math.atan(320 / f), 1e-6)
  assertClose(one.uMin, -one.uMax, 1e-6)
  assertClose(one.vMax, 180, 0.5)
  assertClose(one.vMin, -180, 0.5)
  const two = cylBounds([rotY(0), rotY(30)], f, 640, 360)
  assertClose(two.uMin, one.uMin, 1e-6)
  assertClose(two.uMax, one.uMax + f * 30 * DEG, 1e-6)
})

test('geometry: outputScale caps area', () => {
  assertClose(outputScale({ uMin: 0, uMax: 10000, vMin: 0, vMax: 2000 }), Math.sqrt(16e6 / 20e6), 1e-12)
  assertEqual(outputScale({ uMin: 0, uMax: 4000, vMin: 0, vMax: 1000 }), 1)
  assertClose(outputScale({ uMin: 0, uMax: 10000, vMin: 0, vMax: 2000 }, 5e6), 0.5, 1e-12)
})

test('geometry: cropRect trims ragged edges', () => {
  const NEVER = 1e9
  const top = Float32Array.from([NEVER, 10, 2.2, 3.5, 1, 3, NEVER, NEVER])
  const bottom = Float32Array.from([-1, 5, 90.7, 88.2, 95, 89.9, -1, -1])
  // Columns 2..5 are valid: y = ceil(3.5) = 4, last row = floor(88.2) = 88.
  assertEqual(cropRect(top, bottom), { x: 2, y: 4, width: 4, height: 85 })
  // Nothing valid.
  assertEqual(cropRect(Float32Array.from([5, 6]), Float32Array.from([1, 2])), { x: 0, y: 0, width: 0, height: 0 })
  // An invalid column between valid ones leaves no usable rectangle.
  assertEqual(cropRect(Float32Array.from([0, NEVER, 0]), Float32Array.from([50, -1, 50])), { x: 0, y: 0, width: 0, height: 0 })
})

test('geometry: recentre keeps a 200 degree sweep unwrapped', () => {
  // rotY(200) is the same rotation as rotY(-160): without recentring, cylProject wraps at 180 from photo 0.
  const Rs = [0, 50, 100, 150, 200].map(rotY)
  const centred = recentre(Rs)
  const yaws = centred.map((R) => yawPitchRoll(R).yaw)
  ;[-100, -50, 0, 50, 100].forEach((want, i) => assertClose(yaws[i], want, 1e-9))
  const b = cylBounds(centred, 500, 640, 360)
  const want = 500 * (200 * DEG + 2 * Math.atan(320 / 500))
  assert(Math.abs((b.uMax - b.uMin) / want - 1) < 0.01, `u span ${b.uMax - b.uMin}, want ${want}`)
  assertEqual(recentre([]), [])
  // Pitch and roll survive the recentring.
  const tilted = [0, 60, 120, 180].map((yaw) => mul(rotY(yaw), mul(rotX(5), rotZ(2))))
  const t = recentre(tilted).map(yawPitchRoll)
  assertClose(t[0].pitch, yawPitchRoll(tilted[0]).pitch, 1e-9)
  assertClose(t[3].roll, 2, 1e-9)
  assertClose(t[0].yaw + t[3].yaw, 0, 1e-9)
})

// Module worker for the panorama stitcher: matches each new photo with the previous one using OpenCV.js
// (spec §4.4 steps 1–4) and, at finish, places every photo with a rotation. stitcher.js is its page-side client.
// Messages are handled one at a time, in order. Protocol:
//   page → worker: { type: 'init', opencvBytes, focalPx, width, height, mode } | { type: 'add', bitmap, yawHint }
//                  | { type: 'finish' }
//   worker → page: { type: 'ready' } | { type: 'progress', stage, done, total } | { type: 'result', ...Result }
//                  | { type: 'error', name: 'StitchError' | 'OpenCVError' | 'Error', message }
// The photo bitmaps stay here until finish (Task 10 warps them), and are closed at the end of finish.
import { loadOpenCV } from '../../shared/lib/opencv.js'
import {
  rotY, apply, nearestRotation, yawPitchRoll, chain, waveCorrect, recentre, focalFromHomographies,
} from './geometry.js'

const MATCH_LONG_SIDE = 800
const ORB_FEATURES = 2000
const RATIO = 0.75
const RANSAC_PX = 3
const MIN_INLIERS = 30
const GYRO_TOLERANCE_DEG = 5
const FOCAL_MIN_PAIRS = 3
const FOCAL_RANGE = 0.25
const GYRO_NOTE = 'One seam was placed from the gyroscope and may be visible'

let cv = null
let cfg = null // { focalPx, width, height, mode }
let added = 0 // photos received, including dropped ones
const photos = [] // kept photos: { bitmap, yawHint }
const pairs = [] // pairs[k] joins photos k and k+1: { H (9 numbers, image k → k+1) | null,
//   inliers (x_k, y_k, x_k+1, y_k+1 per match, full-res px) | null, rij, gyro }
let prev = null // features of the last kept photo: { points (full-res x, y pairs), desc: cv.Mat }
let dropped = false // studio: a pair failed, so this photo and all later ones are dropped

let queue = Promise.resolve()
self.onmessage = (e) => { queue = queue.then(() => handle(e.data)) }

async function handle(msg) {
  if (msg.type === 'init') return init(msg)
  if (!cv) {
    msg.bitmap?.close()
    return
  }
  try {
    if (msg.type === 'add') addPhoto(msg.bitmap, msg.yawHint)
    else if (msg.type === 'finish') finish()
  } catch (err) {
    self.postMessage({ type: 'error', name: err?.name === 'StitchError' ? 'StitchError' : 'Error', message: errorMessage(err) })
  }
}

async function init({ opencvBytes, focalPx, width, height, mode }) {
  try {
    cv = await loadOpenCV(new Uint8Array(opencvBytes))
  } catch (err) {
    self.postMessage({ type: 'error', name: 'OpenCVError', message: errorMessage(err) })
    return
  }
  cfg = { focalPx, width, height, mode }
  self.postMessage({ type: 'ready' })
}

function addPhoto(bitmap, yawHint) {
  added++
  if (dropped) {
    bitmap.close()
    return
  }
  let features
  try {
    features = detect(bitmap)
  } catch (err) {
    bitmap.close()
    throw err
  }
  photos.push({ bitmap, yawHint })
  if (photos.length === 1) {
    prev = features
    return
  }
  const j = photos.length - 1
  let match
  try {
    match = matchPair(prev, features)
  } finally {
    prev.desc.delete()
    prev = features
  }
  const hintI = photos[j - 1].yawHint, hintJ = yawHint
  const hinted = cfg.mode === 'live' && Number.isFinite(hintI) && Number.isFinite(hintJ)
  const hintStep = hinted ? wrap180(hintJ - hintI) : 0
  // Rij maps photo i's camera rays to photo j's (Rij = R_jᵀ·R_i), so the yaw step i → j is minus Rij's yaw.
  if (match && hinted && Math.abs(-yawPitchRoll(match.rij).yaw - hintStep) > GYRO_TOLERANCE_DEG) match = null
  if (match) {
    pairs.push({ ...match, gyro: false })
  } else if (hinted) {
    pairs.push({ H: null, inliers: null, rij: rotY(-hintStep), gyro: true })
  } else {
    dropped = true
    photos.pop().bitmap.close()
    prev.desc.delete()
    prev = null
  }
  self.postMessage({ type: 'progress', stage: 'match', done: j, total: added - 1 })
}

// ORB keypoints and descriptors on a grey copy at most MATCH_LONG_SIDE px on its long side. Keypoints are returned
// in full-resolution photo pixels, because K uses the full-resolution focal length and centre.
function detect(bitmap) {
  const scale = Math.min(1, MATCH_LONG_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  const sx = bitmap.width / w, sy = bitmap.height / h
  let rgba, grey, mask, keypoints, orb
  const desc = new cv.Mat()
  try {
    rgba = cv.matFromImageData(ctx.getImageData(0, 0, w, h))
    grey = new cv.Mat()
    cv.cvtColor(rgba, grey, cv.COLOR_RGBA2GRAY)
    orb = new cv.ORB(ORB_FEATURES)
    keypoints = new cv.KeyPointVector()
    mask = new cv.Mat()
    orb.detectAndCompute(grey, mask, keypoints, desc)
    const points = new Float64Array(keypoints.size() * 2)
    for (let k = 0; k < keypoints.size(); k++) {
      const { x, y } = keypoints.get(k).pt
      // Pixel centres sit at integer coordinates, so scale about the -0.5 pixel edge.
      points[2 * k] = (x + 0.5) * sx - 0.5
      points[2 * k + 1] = (y + 0.5) * sy - 0.5
    }
    return { points, desc }
  } catch (err) {
    desc.delete()
    throw err
  } finally {
    for (const m of [rgba, grey, mask, keypoints, orb]) m?.delete()
  }
}

// Hamming kNN with a ratio test, then a RANSAC homography from photo a's points to photo b's.
// Returns { H, inliers, rij } with at least MIN_INLIERS inliers, or null.
function matchPair(a, b) {
  if (a.desc.rows < MIN_INLIERS || b.desc.rows < MIN_INLIERS) return null
  let matcher, knn, src, dst, inliers, H
  try {
    matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
    knn = new cv.DMatchVectorVector()
    matcher.knnMatch(a.desc, b.desc, knn, 2)
    const from = [], to = []
    for (let k = 0; k < knn.size(); k++) {
      const m = knn.get(k)
      try {
        if (m.size() < 2) continue
        const best = m.get(0)
        if (best.distance < RATIO * m.get(1).distance) {
          from.push(a.points[2 * best.queryIdx], a.points[2 * best.queryIdx + 1])
          to.push(b.points[2 * best.trainIdx], b.points[2 * best.trainIdx + 1])
        }
      } finally {
        m.delete()
      }
    }
    const n = from.length / 2
    if (n < MIN_INLIERS) return null
    src = cv.matFromArray(n, 1, cv.CV_32FC2, from)
    dst = cv.matFromArray(n, 1, cv.CV_32FC2, to)
    inliers = new cv.Mat()
    H = cv.findHomography(src, dst, cv.RANSAC, RANSAC_PX, inliers)
    if (H.empty()) return null
    const kept = []
    for (let k = 0; k < n; k++) {
      if (inliers.data[k]) kept.push(from[2 * k], from[2 * k + 1], to[2 * k], to[2 * k + 1])
    }
    if (kept.length / 4 < MIN_INLIERS) return null
    const pts = Float64Array.from(kept)
    return { H: Array.from(H.data64F), inliers: pts, rij: rotationFromRays(pts, cfg.focalPx).rij }
  } finally {
    for (const m of [matcher, knn, src, dst, inliers, H]) m?.delete()
  }
}

function finish() {
  try {
    const used = photos.length
    if (used < 2) throw stitchError(added < 2 ? 'At least 2 photos are needed.' : "Frames 1 and 2 didn't match.")
    const { yaws, rolls } = place()
    const notes = []
    if (dropped) notes.push(`Stitched frames 1–${used}; frame ${used + 1} didn't match.`)
    if (pairs.some((p) => p.gyro)) notes.push(GYRO_NOTE)
    self.postMessage({ type: 'result', blob: null, width: 0, height: 0, notes, used, yaws, rolls })
  } finally {
    for (const p of photos) p.bitmap.close()
    photos.length = 0
    prev?.desc.delete()
    prev = null
  }
}

// Rotation between neighbours from their inlier correspondences (spec §4.4 step 1's camera rotation). With
// a = normalise(K^-1 x_i) and b = normalise(K^-1 x_j), Rij = nearestRotation(Σ b·aᵀ) (Kabsch), so b ≈ Rij·a,
// the same Rij as K^-1 H K. It replaces polar(K^-1 H K) for accuracy: H's 8 degrees of freedom absorb sub-pixel
// noise on a partial overlap, which put up to 0.26° of yaw error per pair on the synthetic pan; this fit
// constrains only the 3 rotational ones. residual = f²·Σ |b − Rij·a|² over the inliers: scaled to pixels², so
// residuals at different focal lengths compare fairly.
function rotationFromRays(inliers, f) {
  const cx = cfg.width / 2, cy = cfg.height / 2
  const ray = (x, y) => {
    const u = (x - cx) / f, v = (y - cy) / f, n = Math.hypot(u, v, 1)
    return [u / n, v / n, 1 / n]
  }
  const as = [], bs = []
  const M = new Array(9).fill(0)
  for (let k = 0; k < inliers.length; k += 4) {
    const a = ray(inliers[k], inliers[k + 1]), b = ray(inliers[k + 2], inliers[k + 3])
    as.push(a)
    bs.push(b)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] += b[r] * a[c]
  }
  const rij = nearestRotation(M)
  let residual = 0
  for (let k = 0; k < as.length; k++) {
    const p = apply(rij, as[k]), b = bs[k]
    residual += (b[0] - p[0]) ** 2 + (b[1] - p[1]) ** 2 + (b[2] - p[2]) ** 2
  }
  return { rij, residual: residual * f * f }
}

// Spec §4.4 steps 3–4: focal refinement, chaining, wave correction, then recentring for the cylinder.
// The closed-form focal from the homographies is ill-conditioned on near-pure-yaw pans, so the candidate is kept only
// when it is within ±25% of the table focal AND lowers the total inlier ray residual over the matched pairs.
// yaws[i] is photo i's unwrapped yaw relative to photo 0 after wave correction, rolls[i] its roll.
function place() {
  const table = cfg.focalPx
  const matched = pairs.filter((p) => !p.gyro)
  let f = table
  let rijs = pairs.map((p) => p.rij)
  if (matched.length >= FOCAL_MIN_PAIRS) {
    const estimate = focalFromHomographies(matched.map((p) => p.H), cfg.width, cfg.height)
    if (estimate !== null && Math.abs(estimate - table) <= FOCAL_RANGE * table) {
      const total = (fits) => fits.reduce((sum, fit) => sum + (fit ? fit.residual : 0), 0)
      const atTable = pairs.map((p) => (p.gyro ? null : rotationFromRays(p.inliers, table)))
      const atEstimate = pairs.map((p) => (p.gyro ? null : rotationFromRays(p.inliers, estimate)))
      if (total(atEstimate) < total(atTable)) {
        f = estimate
        rijs = pairs.map((p, k) => (p.gyro ? p.rij : atEstimate[k].rij))
      }
    }
  }
  const level = waveCorrect(chain(rijs))
  const angles = level.map(yawPitchRoll)
  const yaws = [0]
  for (let i = 1; i < angles.length; i++) yaws.push(yaws[i - 1] + wrap180(angles[i].yaw - angles[i - 1].yaw))
  return { f, rotations: recentre(level), yaws, rolls: angles.map((a) => a.roll) }
}

function wrap180(deg) {
  let d = deg % 360
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d
}

function stitchError(message) {
  const e = new Error(message)
  e.name = 'StitchError'
  return e
}

// OpenCV.js throws cv::Exception as a bare pointer number.
function errorMessage(err) {
  if (typeof err === 'number' && cv?.exceptionFromPtr) {
    try { return cv.exceptionFromPtr(err).msg } catch { /* fall through */ }
  }
  return String(err?.message ?? err)
}

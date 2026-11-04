// Module worker for the panorama stitcher: matches each new photo with the previous one using OpenCV.js
// (spec §4.4 steps 1–4) and, at finish, places every photo with a rotation, projects them onto a cylinder with
// gain compensation and feathered blending, crops and encodes a JPEG (steps 5–8). stitcher.js is its page-side
// client. Messages are handled one at a time, in order. Protocol:
//   page → worker: { type: 'init', opencvBytes, focalPx, width, height, mode } | { type: 'add', bitmap, yawHint }
//                  | { type: 'finish' }
//   worker → page: { type: 'ready' } | { type: 'progress', stage, done, total } | { type: 'result', ...Result }
//                  | { type: 'error', name: 'StitchError' | 'OpenCVError' | 'Error', message }
// The photo bitmaps stay here until finish; each is closed once its last output strip is warped, and any left are
// closed at the end of finish.
import { loadOpenCV } from '../../shared/lib/opencv.js'
import {
  rotY, apply, nearestRotation, yawPitchRoll, chain, waveCorrect, recentre, focalFromHomographies,
  cylBounds, outputScale, cropRect,
} from './geometry.js'
import { toThumb } from './thumb.js'

const MATCH_LONG_SIDE = 800
const ORB_FEATURES = 2000
const RATIO = 0.75
const RANSAC_PX = 3
const MIN_INLIERS = 30
const GYRO_TOLERANCE_DEG = 5
const FOCAL_MIN_PAIRS = 3
const FOCAL_RANGE = 0.25
const GYRO_NOTE = 'One seam was placed from the gyroscope and may be visible'
// The output is built in vertical strips this many columns wide, so the Float32 accumulators stay strip-sized
// (a full 16 MP RGB + weight accumulator would be ~256 MB, too much for an iPhone tab).
const STRIP_COLS = 1024
const GAIN_SCALE = 1 / 4 // gain pre-pass resolution, relative to the output
const JPEG_QUALITY = 0.9

let cv = null
let cfg = null // { focalPx, width, height, mode }
let added = 0 // photos received, including dropped ones
const photos = [] // kept photos: { bitmap, yawHint, mat (RGBA source, only while finish warps it) }
const pairs = [] // pairs[k] joins photos k and k+1: { H (9 numbers, image k → k+1) | null,
//   inliers (x_k, y_k, x_k+1, y_k+1 per match, full-res px) | null, rij, gyro }
let prev = null // features of the last kept photo: { points (full-res x, y pairs), desc: cv.Mat }
let dropped = false // studio: a pair failed, so this photo and all later ones are dropped

let queue = Promise.resolve()
self.onmessage = (e) => {
  // The catch keeps the queue alive if a handler ever rejects.
  queue = queue.then(() => handle(e.data)).catch((err) => {
    self.postMessage({ type: 'error', name: 'Error', message: errorMessage(err) })
  })
}

async function handle(msg) {
  if (msg.type === 'init') return init(msg)
  if (!cv) {
    msg.bitmap?.close()
    if (msg.type === 'finish') self.postMessage({ type: 'error', name: 'OpenCVError', message: 'OpenCV is not ready' })
    return
  }
  try {
    if (msg.type === 'add') addPhoto(msg.bitmap, msg.yawHint)
    else if (msg.type === 'finish') await finish()
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
  progress('match', j, added - 1)
}

function progress(stage, done, total) {
  self.postMessage({ type: 'progress', stage, done, total })
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

async function finish() {
  try {
    const used = photos.length
    if (used < 2) throw stitchError(added < 2 ? 'At least 2 photos are needed.' : "Frames 1 and 2 didn't match.")
    const { f, rotations, yaws, rolls } = place()
    const canvas = composite(f, rotations)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    progress('encode', 1, 1)
    const notes = []
    if (dropped) notes.push(`Stitched frames 1–${used}; frame ${used + 1} didn't match.`)
    if (pairs.some((p) => p.gyro)) notes.push(GYRO_NOTE)
    self.postMessage({ type: 'result', blob, width: canvas.width, height: canvas.height, notes, used, yaws, rolls })
  } finally {
    for (const p of photos) {
      p.mat?.delete()
      p.bitmap.close()
    }
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

// Spec §4.4 steps 5–8 up to the encode: returns a crop-sized OffscreenCanvas holding the panorama. Rs are the
// recentred rotations. Output pixel (X, Y) is cylinder point u = uMin + (X + 0.5)/s, v = vMin + (Y + 0.5)/s, where
// s = outputScale(bounds) <= 1 keeps the area within 16 MP.
// The output is built in STRIP_COLS-wide strips. For each strip only the photos whose u-range meets it are warped
// (cv.remap), Σ w·g·RGB and Σ w are accumulated in strip-sized Float32 buffers, then normalised into one RGBA array
// of the output size. A photo's RGBA source Mat lives from its first strip to its last; then it and its bitmap are
// released. The feather weight w is the warped pixel's distance to its photo's edge (see edgeWeight).
function composite(f, Rs) {
  const bounds = cylBounds(Rs, f, cfg.width, cfg.height)
  const s = outputScale(bounds)
  const outW = Math.ceil((bounds.uMax - bounds.uMin) * s), outH = Math.ceil((bounds.vMax - bounds.vMin) * s)
  const grid = { uMin: bounds.uMin, vMin: bounds.vMin, s, width: outW, height: outH }
  const photoBounds = Rs.map((R) => cylBounds([R], f, cfg.width, cfg.height))
  const gains = gainChain(f, Rs, photoBounds, {
    ...grid, s: s * GAIN_SCALE, width: Math.ceil(outW * GAIN_SCALE), height: Math.ceil(outH * GAIN_SCALE),
  })
  const windows = photoBounds.map((b) => gridWindow(b, grid))

  const out = new Uint8ClampedArray(outW * outH * 4)
  const colTop = new Float64Array(outW).fill(Infinity), colBottom = new Float64Array(outW).fill(-Infinity)
  const stripCols = Math.min(STRIP_COLS, outW)
  const acc = new Float32Array(stripCols * outH * 3), wsum = new Float32Array(stripCols * outH)
  let warped = 0
  for (let x0 = 0; x0 < outW; x0 += STRIP_COLS) {
    const sw = Math.min(STRIP_COLS, outW - x0)
    acc.fill(0)
    wsum.fill(0)
    for (let i = 0; i < Rs.length; i++) {
      const win = windows[i]
      if (win.x1 < x0 || win.x0 >= x0 + sw) continue
      warpInto(photos[i], Rs[i], f, grid, win, x0, sw, gains[i], acc, wsum)
      if (win.x1 < x0 + sw) { // this was the photo's last strip
        photos[i].mat.delete()
        photos[i].mat = null
        photos[i].bitmap.close()
        progress('warp', ++warped, Rs.length)
      }
    }
    for (let Y = 0; Y < outH; Y++) {
      for (let c = 0, j = Y * sw, o = (Y * outW + x0) * 4; c < sw; c++, j++, o += 4) {
        const w = wsum[j]
        if (w > 0) {
          out[o] = acc[3 * j] / w
          out[o + 1] = acc[3 * j + 1] / w
          out[o + 2] = acc[3 * j + 2] / w
          if (colTop[x0 + c] === Infinity) colTop[x0 + c] = Y
          colBottom[x0 + c] = Y
        }
        out[o + 3] = 255
      }
    }
  }
  progress('blend', 1, 1)

  const crop = cropRect(...trimEnds(colTop, colBottom))
  if (crop.width === 0) throw stitchError('The photos cover no area.')
  const canvas = new OffscreenCanvas(crop.width, crop.height)
  // The dirty rectangle copies only the crop, without a second output-sized buffer.
  canvas.getContext('2d').putImageData(new ImageData(out, outW, outH), -crop.x, -crop.y,
    crop.x, crop.y, crop.width, crop.height)
  return canvas
}

// cropRect intersects the coverage of every column between the first and last covered ones, but a pitched or
// rolled photo's outer edge slants on the cylinder, so the end columns are only partly covered and would collapse
// the crop's height. This picks the column interval [l, r] whose cropRect area is largest and returns copies of
// colTop and colBottom with the columns outside it marked uncovered. Exact search with pruning: an interval's height
// never exceeds its first column's, and only shrinks as it grows to the right.
function trimEnds(colTop, colBottom) {
  const n = colTop.length
  const height = (top, bottom) => Math.floor(bottom) - Math.ceil(top) + 1
  let first = 0, last = n - 1
  while (first < n && !(colTop[first] <= colBottom[first])) first++
  while (last > first && !(colTop[last] <= colBottom[last])) last--
  let best = 0, bestL = 0, bestR = -1
  for (let l = first; l <= last; l++) {
    if ((last - l + 1) * height(colTop[l], colBottom[l]) <= best) continue
    let top = -Infinity, bottom = Infinity
    for (let r = l; r <= last; r++) {
      if (colTop[r] > top) top = colTop[r]
      if (colBottom[r] < bottom) bottom = colBottom[r]
      const h = height(top, bottom)
      if (!(h > 0) || (last - l + 1) * h <= best) break
      if ((r - l + 1) * h > best) {
        best = (r - l + 1) * h
        bestL = l
        bestR = r
      }
    }
  }
  const tops = new Float64Array(n).fill(Infinity), bottoms = new Float64Array(n).fill(-Infinity)
  tops.set(colTop.subarray(bestL, bestR + 1), bestL)
  bottoms.set(colBottom.subarray(bestL, bestR + 1), bestL)
  return [tops, bottoms]
}

// Spec §4.4 step 6, simplified to a chain. On a pre-pass grid at GAIN_SCALE of the output, mean_i and mean_i+1 are
// the mean lumas of photos i and i+1 (from GAIN_SCALE thumbnails) over the grid points both see with weight > 0;
// g_0 = 1 and g_i+1 = g_i · mean_i / mean_i+1. A pair with no overlap (or a near-black mean_i+1) carries the gain over.
function gainChain(f, Rs, photoBounds, grid) {
  const windows = photoBounds.map((b) => gridWindow(b, grid))
  const thumbWidth = Math.max(1, Math.round(cfg.width * GAIN_SCALE))
  const gains = [1]
  let a = toThumb(photos[0].bitmap, thumbWidth)
  for (let i = 0; i + 1 < Rs.length; i++) {
    const b = toThumb(photos[i + 1].bitmap, thumbWidth)
    const wa = windows[i], wb = windows[i + 1]
    const x0 = Math.max(wa.x0, wb.x0), x1 = Math.min(wa.x1, wb.x1)
    const y0 = Math.max(wa.y0, wb.y0), y1 = Math.min(wa.y1, wb.y1)
    let sumA = 0, sumB = 0, count = 0
    if (x0 <= x1 && y0 <= y1) {
      const n = y1 - y0 + 1
      const ax = new Float32Array(n), ay = new Float32Array(n), bx = new Float32Array(n), by = new Float32Array(n)
      for (let X = x0; X <= x1; X++) {
        fillColumn(Rs[i], f, grid, X, y0, n, ax, ay, 0, 1)
        fillColumn(Rs[i + 1], f, grid, X, y0, n, bx, by, 0, 1)
        for (let k = 0; k < n; k++) {
          if (edgeWeight(ax[k], ay[k]) > 0 && edgeWeight(bx[k], by[k]) > 0) {
            sumA += lumaAt(a, ax[k], ay[k])
            sumB += lumaAt(b, bx[k], by[k])
            count++
          }
        }
      }
    }
    gains.push(count > 0 && sumB > count ? gains[i] * sumA / sumB : gains[i])
    a = b
  }
  return gains
}

// Nearest thumbnail luma at full-resolution photo pixel (x, y).
function lumaAt(thumb, x, y) {
  const tx = Math.round((x + 0.5) * thumb.width / cfg.width - 0.5)
  const ty = Math.round((y + 0.5) * thumb.height / cfg.height - 0.5)
  return thumb.data[Math.min(thumb.height - 1, Math.max(0, ty)) * thumb.width + Math.min(thumb.width - 1, Math.max(0, tx))]
}

// Remaps the photo onto the output columns of strip [x0, x0 + sw) inside its window, and adds w·g·RGB and w into
// the strip accumulators (row stride sw).
function warpInto(photo, R, f, grid, win, x0, sw, gain, acc, wsum) {
  const c0 = Math.max(x0, win.x0), c1 = Math.min(x0 + sw - 1, win.x1)
  const pw = c1 - c0 + 1, ph = win.y1 - win.y0 + 1
  const src = sourceMat(photo)
  let mapX, mapY, warped
  try {
    mapX = new cv.Mat(ph, pw, cv.CV_32FC1)
    mapY = new cv.Mat(ph, pw, cv.CV_32FC1)
    const mx = mapX.data32F, my = mapY.data32F
    for (let c = 0; c < pw; c++) fillColumn(R, f, grid, c0 + c, win.y0, ph, mx, my, c, pw)
    warped = new cv.Mat()
    cv.remap(src, warped, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
    // Fresh views: the WASM heap may have grown during remap, detaching the earlier ones.
    const xs = mapX.data32F, ys = mapY.data32F, px = warped.data
    for (let r = 0; r < ph; r++) {
      for (let c = 0, k = r * pw, j = (win.y0 + r) * sw + (c0 - x0); c < pw; c++, k++, j++) {
        const w = edgeWeight(xs[k], ys[k])
        if (w <= 0) continue
        const wg = w * gain
        acc[3 * j] += wg * px[4 * k]
        acc[3 * j + 1] += wg * px[4 * k + 1]
        acc[3 * j + 2] += wg * px[4 * k + 2]
        wsum[j] += w
      }
    }
  } finally {
    for (const m of [mapX, mapY, warped]) m?.delete()
  }
}

// The photo's RGBA pixels as a CV_8UC4 Mat, made on first use.
function sourceMat(photo) {
  if (!photo.mat) {
    const { width, height } = cfg
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    ctx.drawImage(photo.bitmap, 0, 0, width, height)
    photo.mat = cv.matFromImageData(ctx.getImageData(0, 0, width, height))
  }
  return photo.mat
}

// Grid pixels (inclusive) that may see a photo whose cylinder bounds are b, with a pixel of margin, clamped to the
// grid { uMin, vMin, s, width, height }.
function gridWindow(b, { uMin, vMin, s, width, height }) {
  const clamp = (x, n) => Math.max(0, Math.min(n - 1, x))
  return {
    x0: clamp(Math.floor((b.uMin - uMin) * s - 0.5) - 1, width),
    x1: clamp(Math.ceil((b.uMax - uMin) * s - 0.5) + 1, width),
    y0: clamp(Math.floor((b.vMin - vMin) * s - 0.5) - 1, height),
    y1: clamp(Math.ceil((b.vMax - vMin) * s - 0.5) + 1, height),
  }
}

// Source pixels in camera R for grid rows y0 .. y0+n-1 of grid column X, written to mapX/mapY from index o in steps
// of stride. Same maths as cylToImage, c = Rᵀ·[sin(u/f), v/f, cos(u/f)], inlined because it runs per output pixel:
// c is linear in v down a column, so a column costs one sin and cos and no allocation. Points behind the camera
// get -1, which is outside the photo, so remap gives 0 there and the weight is 0.
function fillColumn(R, f, grid, X, y0, n, mapX, mapY, o, stride) {
  const cx = cfg.width / 2, cy = cfg.height / 2
  const u = grid.uMin + (X + 0.5) / grid.s
  const su = Math.sin(u / f), cu = Math.cos(u / f)
  const a0 = su * R[0] + cu * R[6], a1 = su * R[1] + cu * R[7], a2 = su * R[2] + cu * R[8]
  for (let k = 0; k < n; k++, o += stride) {
    const t = (grid.vMin + (y0 + k + 0.5) / grid.s) / f
    const z = a2 + t * R[5]
    if (z <= 1e-9) {
      mapX[o] = -1
      mapY[o] = -1
    } else {
      mapX[o] = f * (a0 + t * R[3]) / z + cx
      mapY[o] = f * (a1 + t * R[4]) / z + cy
    }
  }
}

// Feather weight of source point (x, y): its distance to the photo's edge, 0 outside the photo. Equivalent to
// warping a distance-to-edge image with the same maps.
function edgeWeight(x, y) {
  return Math.max(0, Math.min(x, cfg.width - 1 - x, y, cfg.height - 1 - y))
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

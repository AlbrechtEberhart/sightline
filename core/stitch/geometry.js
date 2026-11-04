// Rotation, homography and cylinder maths for the panorama stitcher. Pure maths, no DOM, no OpenCV.
//
// Conventions (used everywhere in core/stitch):
// - Camera axes: x right, y down, z forward. Matrices are row-major arrays of 9 numbers.
// - An absolute rotation R maps camera rays to world rays. Photo 0 has R = I.
// - Yaw is positive turning right (about world y), pitch is positive looking up, roll is about the view axis.
// - For neighbours i and j, H maps image-i pixels to image-j pixels and Rij = K^-1 H K (made orthonormal),
//   so R_j = R_i * Rij^T.

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

// Standard right-handed matrices. With y down, rotY(+) turns the forward ray (0,0,1) right and rotX(+) turns it up.
export function rotX(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

export function rotY(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}

export function rotZ(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

export function mul(a, b) {
  const out = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

export function transpose(a) {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]
}

export function apply(R, v) {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ]
}

export function intrinsics(f, cx, cy) {
  return [f, 0, cx, 0, f, cy, 0, 0, 1]
}

function intrinsicsInverse(f, cx, cy) {
  return [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1]
}

function det(a) {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n]
}

// Unit vector perpendicular to the unit vector u.
function perpendicular(u) {
  const ax = Math.abs(u[0]), ay = Math.abs(u[1]), az = Math.abs(u[2])
  const basis = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  return normalize(cross(u, basis))
}

// One-sided Jacobi SVD of a 3x3: M = U * diag(S) * V^T, S descending, U and V orthogonal.
// Where a singular value is (numerically) zero the matching U column is completed to an orthonormal basis.
function svd3(M) {
  const A = M.slice()
  const V = IDENTITY.slice()
  for (let sweep = 0; sweep < 40; sweep++) {
    let rotated = false
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        let alpha = 0, beta = 0, gamma = 0
        for (let r = 0; r < 3; r++) {
          const ap = A[r * 3 + p], aq = A[r * 3 + q]
          alpha += ap * ap
          beta += aq * aq
          gamma += ap * aq
        }
        if (gamma === 0 || Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue
        rotated = true
        const zeta = (beta - alpha) / (2 * gamma)
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta))
        const c = 1 / Math.sqrt(1 + t * t)
        const s = c * t
        for (const X of [A, V]) {
          for (let r = 0; r < 3; r++) {
            const xp = X[r * 3 + p], xq = X[r * 3 + q]
            X[r * 3 + p] = c * xp - s * xq
            X[r * 3 + q] = s * xp + c * xq
          }
        }
      }
    }
    if (!rotated) break
  }
  const norms = [0, 1, 2].map((j) => Math.hypot(A[j], A[3 + j], A[6 + j]))
  const order = [0, 1, 2].sort((a, b) => norms[b] - norms[a])
  const S = order.map((j) => norms[j])
  const tol = 1e-12 * S[0]
  const column = (j, scale) => [A[j] / scale, A[3 + j] / scale, A[6 + j] / scale]
  const u0 = S[0] > 0 ? column(order[0], S[0]) : [1, 0, 0]
  const u1 = S[1] > tol ? column(order[1], S[1]) : perpendicular(u0)
  const u2 = S[2] > tol ? column(order[2], S[2]) : cross(u0, u1)
  const U = [u0[0], u1[0], u2[0], u0[1], u1[1], u2[1], u0[2], u1[2], u2[2]]
  const Vs = new Array(9)
  order.forEach((j, k) => {
    for (let r = 0; r < 3; r++) Vs[r * 3 + k] = V[r * 3 + j]
  })
  return { U, S, V: Vs }
}

// Closest proper rotation to M (polar decomposition U*V^T, with the smallest singular direction flipped if det < 0).
export function nearestRotation(M) {
  const { U, V } = svd3(M)
  const Vt = transpose(V)
  const R = mul(U, Vt)
  if (det(R) >= 0) return R
  const flipped = U.slice()
  flipped[2] = -flipped[2]
  flipped[5] = -flipped[5]
  flipped[8] = -flipped[8]
  return mul(flipped, Vt)
}

// Rij = K^-1 H K for H mapping image-i pixels to image-j pixels, made orthonormal.
// H is only defined up to scale, so a negative-determinant result is negated before the polar step removes the
// positive scale.
export function rotationFromHomography(H, f, cx, cy) {
  let M = mul(intrinsicsInverse(f, cx, cy), mul(H, intrinsics(f, cx, cy)))
  if (det(M) < 0) M = M.map((v) => -v)
  return nearestRotation(M)
}

// Decomposes R = rotY(yaw) * rotX(pitch) * rotZ(roll); angles in degrees.
// Expanded, R[1][2] = -sin(pitch), R[0][2] = sin(yaw)cos(pitch), R[2][2] = cos(yaw)cos(pitch),
// R[1][0] = cos(pitch)sin(roll) and R[1][1] = cos(pitch)cos(roll).
export function yawPitchRoll(R) {
  return {
    yaw: Math.atan2(R[2], R[8]) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -R[5]))) * DEG,
    roll: Math.atan2(R[3], R[4]) * DEG,
  }
}

// Absolute rotations from neighbour rotations: R_0 = I, R_{k+1} = R_k * Rij_k^T. Length is rijList.length + 1.
export function chain(rijList) {
  const out = [IDENTITY.slice()]
  for (const rij of rijList) out.push(mul(out[out.length - 1], transpose(rij)))
  return out
}

// Minimal rotation taking unit vector a to unit vector b (Rodrigues).
function rotationBetween(a, b) {
  const c = dot(a, b)
  if (c > 1 - 1e-12) return IDENTITY.slice()
  if (c < -1 + 1e-12) {
    // Half turn about any axis perpendicular to a: 2uu^T - I.
    const u = perpendicular(a)
    return [
      2 * u[0] * u[0] - 1, 2 * u[0] * u[1], 2 * u[0] * u[2],
      2 * u[1] * u[0], 2 * u[1] * u[1] - 1, 2 * u[1] * u[2],
      2 * u[2] * u[0], 2 * u[2] * u[1], 2 * u[2] * u[2] - 1,
    ]
  }
  const v = cross(a, b)
  const k = 1 / (1 + c)
  const vx = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0]
  const vx2 = mul(vx, vx)
  return IDENTITY.map((id, i) => id + vx[i] + k * vx2[i])
}

// Horizontal wave correction. The cameras' x-axes should lie in the horizon plane; the eigenvector of the
// smallest eigenvalue of their covariance is that plane's normal ("up"), signed to agree with the mean camera -y.
// Every R is premultiplied by the rotation taking up to world -y. Fewer than two cameras are returned unchanged.
export function waveCorrect(Rs) {
  if (Rs.length < 2) return Rs.map((R) => R.slice())
  const cov = new Array(9).fill(0)
  const meanUp = [0, 0, 0]
  for (const R of Rs) {
    const x = [R[0], R[3], R[6]]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) cov[r * 3 + c] += x[r] * x[c]
    }
    meanUp[0] -= R[1]
    meanUp[1] -= R[4]
    meanUp[2] -= R[7]
  }
  const { V } = svd3(cov)
  let up = [V[2], V[5], V[8]]
  if (dot(up, meanUp) < 0) up = [-up[0], -up[1], -up[2]]
  const C = rotationBetween(up, [0, -1, 0])
  return Rs.map((R) => mul(C, R))
}

// Recentres the panorama's yaw so its middle sits at yaw 0. Photo 0 is pinned at yaw 0, so a wide sweep would
// otherwise cross the atan2 wrap at +-180 degrees in cylProject. Yaws are unwrapped along the chain (each step
// taken in (-180, 180]), then every R is premultiplied by rotY(-mid), mid being the mean of the first and last
// unwrapped yaws; roll and pitch are left as they were. Run it after waveCorrect and before cylBounds/cylProject.
export function recentre(Rs) {
  if (Rs.length === 0) return []
  const first = yawPitchRoll(Rs[0]).yaw
  let last = first
  let prev = first
  for (let i = 1; i < Rs.length; i++) {
    const yaw = yawPitchRoll(Rs[i]).yaw
    let step = yaw - prev
    if (step > 180) step -= 360
    else if (step <= -180) step += 360
    last += step
    prev = yaw
  }
  const C = rotY(-(first + last) / 2)
  return Rs.map((R) => mul(C, R))
}

// Focal length in pixels from pairwise homographies (each maps image i to image j, in pixel coordinates).
// Port of OpenCV focalsFromHomography (modules/stitching/src/autocalib.cpp), which expects centred coordinates,
// so each H is first moved to the image centre: Hc = T^-1 H T with T translating by (width/2, height/2).
// A pair is valid when both of its focal estimates are; its estimate is sqrt(f0 * f1). Returns the median, or null.
export function focalFromHomographies(Hs, width, height) {
  const cx = width / 2, cy = height / 2
  const T = [1, 0, cx, 0, 1, cy, 0, 0, 1]
  const Tinv = [1, 0, -cx, 0, 1, -cy, 0, 0, 1]
  const estimates = []
  for (const H of Hs) {
    const h = mul(Tinv, mul(H, T))
    const f1 = focalCandidate(-(h[0] * h[1] + h[3] * h[4]), h[6] * h[7],
      h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4], (h[7] - h[6]) * (h[7] + h[6]))
    const f0 = focalCandidate(-h[2] * h[5], h[0] * h[3] + h[1] * h[4],
      h[5] * h[5] - h[2] * h[2], h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4])
    if (f0 !== null && f1 !== null) estimates.push(Math.sqrt(f0 * f1))
  }
  if (estimates.length === 0) return null
  estimates.sort((a, b) => a - b)
  const mid = estimates.length >> 1
  return estimates.length % 2 ? estimates[mid] : (estimates[mid - 1] + estimates[mid]) / 2
}

// One focal estimate from the two candidate squares n1/d1 and n2/d2, as OpenCV picks them. Null when invalid.
function focalCandidate(n1, d1, n2, d2) {
  let v1 = n1 / d1
  let v2 = n2 / d2
  if (v1 < v2) [v1, v2] = [v2, v1]
  let f = null
  if (v1 > 0 && v2 > 0) f = Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2)
  else if (v1 > 0) f = Math.sqrt(v1)
  return Number.isFinite(f) ? f : null
}

// Cylinder coordinates of pixel (x, y) in a camera with rotation R: u = f*theta, v = f*h, where the world ray is
// d = R K^-1 [x, y, 1], theta = atan2(d.x, d.z) and h = d.y / hypot(d.x, d.z). No offset is applied.
export function cylProject(R, f, x, y, cx, cy) {
  const d = apply(R, [(x - cx) / f, (y - cy) / f, 1])
  return [f * Math.atan2(d[0], d[2]), f * d[1] / Math.hypot(d[0], d[2])]
}

// Inverse of cylProject: the pixel of camera R that sees cylinder point (u, v), or null if it is behind the camera.
export function cylToImage(R, f, u, v, cx, cy) {
  const c = apply(transpose(R), [Math.sin(u / f), v / f, Math.cos(u / f)])
  if (c[2] <= 1e-9) return null
  return [f * c[0] / c[2] + cx, f * c[1] / c[2] + cy]
}

// Extent of all photos on the cylinder, from 32 points along each border edge. Assumes the panorama does not
// wrap past +-180 degrees of yaw.
export function cylBounds(Rs, f, width, height) {
  const cx = width / 2, cy = height / 2
  const n = 32
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  const add = (R, x, y) => {
    const [u, v] = cylProject(R, f, x, y, cx, cy)
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }
  for (const R of Rs) {
    for (let i = 0; i < n; i++) {
      const x = width * i / (n - 1)
      const y = height * i / (n - 1)
      add(R, x, 0)
      add(R, x, height)
      add(R, 0, y)
      add(R, width, y)
    }
  }
  return { uMin, uMax, vMin, vMax }
}

// Scale (at most 1) that keeps the output area within maxPixels.
export function outputScale(bounds, maxPixels = 16e6) {
  const area = (bounds.uMax - bounds.uMin) * (bounds.vMax - bounds.vMin)
  return Math.min(1, Math.sqrt(maxPixels / area))
}

// Largest axis-aligned crop inside ragged per-column coverage. A column is valid when colTop <= colBottom.
// Leading and trailing invalid columns are trimmed; y is the ceiling of the largest colTop and the bottom edge the
// floor of the smallest colBottom over the remaining columns. An empty result is all zeros.
export function cropRect(colTop, colBottom) {
  let first = -1, last = -1
  for (let i = 0; i < colTop.length; i++) {
    if (colTop[i] <= colBottom[i]) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return { x: 0, y: 0, width: 0, height: 0 }
  let top = -Infinity, bottom = Infinity
  for (let i = first; i <= last; i++) {
    if (colTop[i] > top) top = colTop[i]
    if (colBottom[i] < bottom) bottom = colBottom[i]
  }
  const y = Math.ceil(top)
  const height = Math.floor(bottom) - y + 1
  if (!(height > 0)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: first, y, width: last - first + 1, height }
}

// cropRect intersects the coverage of every column between the first and last covered ones, but a pitched or rolled
// photo's outer edge slants on the cylinder, so the end columns are only partly covered and would collapse the crop's
// height. trimEnds picks the column interval [l, r] whose cropRect area is largest and returns copies of colTop and
// colBottom (Float64Array) with the columns outside it marked uncovered (Infinity / -Infinity), ready for cropRect.
// An interval never spans an uncovered column. Exact search with pruning: an interval's height never exceeds its first
// column's, and only shrinks as it grows to the right.
export function trimEnds(colTop, colBottom) {
  const n = colTop.length
  const height = (top, bottom) => Math.floor(bottom) - Math.ceil(top) + 1
  let first = 0, last = n - 1
  while (first < n && !(colTop[first] <= colBottom[first])) first++
  while (last > first && !(colTop[last] <= colBottom[last])) last--
  let best = 0, bestL = 0, bestR = -1
  for (let l = first; l <= last; l++) {
    if (!((last - l + 1) * height(colTop[l], colBottom[l]) > best)) continue
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
  for (let i = bestL; i <= bestR; i++) {
    tops[i] = colTop[i]
    bottoms[i] = colBottom[i]
  }
  return [tops, bottoms]
}

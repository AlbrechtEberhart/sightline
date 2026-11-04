// Phase-correlation shift between two same-sized thumbnails. Pure maths, no DOM.
// phaseShift(a, b) gives how far b's content moved relative to a, in thumbnail pixels
// (positive dx = right, positive dy = down), plus the correlation peak (0..1).

function nextPow2(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

// In-place radix-2 FFT of n samples held in the scratch arrays tr/ti (unscaled).
function fft1d(n, inverse, tr, ti) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = tr[i]; tr[i] = tr[j]; tr[j] = t
      t = ti[i]; ti[i] = ti[j]; ti[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = tr[b] * cr - ti[b] * ci
        const xi = tr[b] * ci + ti[b] * cr
        tr[b] = tr[a] - xr; ti[b] = ti[a] - xi
        tr[a] += xr; ti[a] += xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

// 2D FFT of a w x h grid (both powers of two), in place, unscaled.
function fft2d(re, im, w, h, inverse) {
  const tr = new Float64Array(Math.max(w, h))
  const ti = new Float64Array(Math.max(w, h))
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let x = 0; x < w; x++) { tr[x] = re[o + x]; ti[x] = im[o + x] }
    fft1d(w, inverse, tr, ti)
    for (let x = 0; x < w; x++) { re[o + x] = tr[x]; im[o + x] = ti[x] }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { tr[y] = re[y * w + x]; ti[y] = im[y * w + x] }
    fft1d(h, inverse, tr, ti)
    for (let y = 0; y < h; y++) { re[y * w + x] = tr[y]; im[y * w + x] = ti[y] }
  }
}

// Mean-removed, Hann-windowed copy of the thumbnail, zero-padded into a pw x ph grid.
function padded({ data, width, height }, pw, ph) {
  let mean = 0
  for (let i = 0; i < data.length; i++) mean += data[i]
  mean /= data.length
  const out = new Float64Array(pw * ph)
  const wx = new Float64Array(width)
  for (let x = 0; x < width; x++) wx[x] = width > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * x / (width - 1)) : 1
  for (let y = 0; y < height; y++) {
    const wy = height > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * y / (height - 1)) : 1
    for (let x = 0; x < width; x++) out[y * pw + x] = (data[y * width + x] - mean) * wx[x] * wy
  }
  return out
}

// Sub-pixel offset of a peak from its neighbours (3-point parabola); 0 when it is flat or not a maximum.
function parabola(l, c, r) {
  const d = l - 2 * c + r
  if (d >= 0) return 0
  return Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d)))
}

export function phaseShift(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new TypeError(`phaseShift: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const pw = nextPow2(a.width)
  const ph = nextPow2(a.height)
  const n = pw * ph
  const ar = padded(a, pw, ph), ai = new Float64Array(n)
  const br = padded(b, pw, ph), bi = new Float64Array(n)
  fft2d(ar, ai, pw, ph, false)
  fft2d(br, bi, pw, ph, false)
  // Normalised cross-power spectrum B * conj(A) / |B * conj(A)|, written over A.
  for (let i = 0; i < n; i++) {
    const re = br[i] * ar[i] + bi[i] * ai[i]
    const im = bi[i] * ar[i] - br[i] * ai[i]
    const mag = Math.hypot(re, im)
    if (mag > 1e-9) { ar[i] = re / mag; ai[i] = im / mag } else { ar[i] = 0; ai[i] = 0 }
  }
  fft2d(ar, ai, pw, ph, true)
  let best = -Infinity
  let bx = 0
  let by = 0
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const v = ar[y * pw + x]
      if (v > best) { best = v; bx = x; by = y }
    }
  }
  const at = (x, y) => ar[((y + ph) % ph) * pw + ((x + pw) % pw)]
  const fx = parabola(at(bx - 1, by), best, at(bx + 1, by))
  const fy = parabola(at(bx, by - 1), best, at(bx, by + 1))
  // Indices past the half-way point are negative shifts that wrapped around.
  const dx = (bx > pw / 2 ? bx - pw : bx) + fx
  const dy = (by > ph / 2 ? by - ph : by) + fy
  return { dx, dy, peak: Math.max(0, Math.min(1, best / n)) }
}

// Letterbox geometry: fit a source frame into a square model input and map boxes back.
// Pure functions, no DOM, no I/O. Boxes are [x, y, w, h] with top-left origin.

export function letterbox(srcW, srcH, size) {
  const scale = Math.min(size / srcW, size / srcH)
  const newW = Math.round(srcW * scale)
  const newH = Math.round(srcH * scale)
  const padX = Math.floor((size - newW) / 2)
  const padY = Math.floor((size - newH) / 2)
  return { scale, newW, newH, padX, padY }
}

export function toInput([x, y, w, h], lb) {
  return [x * lb.scale + lb.padX, y * lb.scale + lb.padY, w * lb.scale, h * lb.scale]
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function toSource([x, y, w, h], lb, srcW, srcH) {
  const sx = (x - lb.padX) / lb.scale
  const sy = (y - lb.padY) / lb.scale
  const sw = w / lb.scale
  const sh = h / lb.scale
  // Clamp both endpoints independently so a box lying fully outside the
  // source yields zero size instead of a negative w or h.
  const x1 = clamp(sx, 0, srcW)
  const y1 = clamp(sy, 0, srcH)
  const x2 = clamp(sx + sw, 0, srcW)
  const y2 = clamp(sy + sh, 0, srcH)
  return [x1, y1, x2 - x1, y2 - y1]
}

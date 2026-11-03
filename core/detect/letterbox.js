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

export function toSource([x, y, w, h], lb, srcW, srcH) {
  const sx = (x - lb.padX) / lb.scale
  const sy = (y - lb.padY) / lb.scale
  const sw = w / lb.scale
  const sh = h / lb.scale
  const x1 = Math.max(0, sx)
  const y1 = Math.max(0, sy)
  const x2 = Math.min(srcW, sx + sw)
  const y2 = Math.min(srcH, sy + sh)
  return [x1, y1, x2 - x1, y2 - y1]
}

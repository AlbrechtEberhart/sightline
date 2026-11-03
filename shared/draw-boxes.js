// Detection box drawing and fit helpers. Pure canvas code, no I/O.
// Boxes are { classId, label, score, box: [x, y, w, h] } in source-image pixels, x and y at top-left.
import { colorFor } from '../core/detect/colors.js'

// Matches CSS object-fit: cover. The source is scaled to fill the destination and cropped.
export function fitCover(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH)
  return {
    scale,
    offsetX: (dstW - srcW * scale) / 2,
    offsetY: (dstH - srcH * scale) / 2,
  }
}

// Matches CSS object-fit: contain. The source is scaled to fit inside the destination, with letterboxing.
export function fitContain(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH)
  return {
    scale,
    offsetX: (dstW - srcW * scale) / 2,
    offsetY: (dstH - srcH * scale) / 2,
  }
}

const TAG_FONT_PX = 12
const TAG_HEIGHT_PX = 18
const TAG_PAD_PX = 4
const TAG_TEXT = '#0b1220'
const STROKE_PX = 2
const RADIUS_PX = 4

// dst = src * scale + offset. Draws each box as a rounded stroke in its class colour,
// with an optional label tag above the box (inside the top edge when there is no room above).
export function drawDetections(ctx, boxes, { scale = 1, offsetX = 0, offsetY = 0, showLabels = true, dpr = 1 } = {}) {
  for (const det of boxes) {
    const [sx, sy, sw, sh] = det.box
    const x = sx * scale + offsetX
    const y = sy * scale + offsetY
    const w = sw * scale
    const h = sh * scale
    const color = colorFor(det.classId)

    ctx.save()
    ctx.lineWidth = STROKE_PX * dpr
    ctx.strokeStyle = color
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, RADIUS_PX * dpr)
    else ctx.rect(x, y, w, h)
    ctx.stroke()
    ctx.restore()

    if (!showLabels) continue

    const text = `${det.label} ${Math.round(det.score * 100)}%`
    const tagH = TAG_HEIGHT_PX * dpr
    const pad = TAG_PAD_PX * dpr
    ctx.save()
    ctx.font = `600 ${TAG_FONT_PX * dpr}px system-ui, sans-serif`
    ctx.textBaseline = 'middle'
    const tagW = ctx.measureText(text).width + 2 * pad
    const tagY = y - tagH < 0 ? y : y - tagH
    ctx.fillStyle = color
    ctx.fillRect(x, tagY, tagW, tagH)
    ctx.fillStyle = TAG_TEXT
    ctx.fillText(text, x + pad, tagY + tagH / 2)
    ctx.restore()
  }
}

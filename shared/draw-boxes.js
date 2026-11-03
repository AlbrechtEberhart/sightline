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

// Draws each box as a rounded outline in its class colour, with a label tag
// ("<label> <score>%") above the box, or inside its top edge when there is no room above.
//
// Coordinate contract: scale, offsetX and offsetY map source-image pixels to canvas
// backing-store pixels, dst = src * scale + offset. Callers compute them with fitCover or
// fitContain against canvas.width and canvas.height, not CSS pixels. dpr only sizes the
// stroke, corner radius and tag. It never moves a box.
//
// The outline is inset by half its width, so the stroke lies inside the box bounds.
// The tag is clamped to the canvas when ctx.canvas is available.
export function drawDetections(ctx, boxes, { scale = 1, offsetX = 0, offsetY = 0, showLabels = true, dpr = 1 } = {}) {
  for (const det of boxes) {
    const [sx, sy, sw, sh] = det.box
    const x = sx * scale + offsetX
    const y = sy * scale + offsetY
    const w = sw * scale
    const h = sh * scale
    const color = colorFor(det.classId)

    const lineWidth = STROKE_PX * dpr
    const half = lineWidth / 2
    ctx.save()
    ctx.lineWidth = lineWidth
    ctx.strokeStyle = color
    ctx.beginPath()
    const rx = x + half
    const ry = y + half
    const rw = Math.max(0, w - lineWidth)
    const rh = Math.max(0, h - lineWidth)
    const radius = Math.max(0, RADIUS_PX * dpr - half)
    if (typeof ctx.roundRect === 'function') ctx.roundRect(rx, ry, rw, rh, radius)
    else ctx.rect(rx, ry, rw, rh)
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
    const canvasW = ctx.canvas?.width
    let tagX = Math.max(0, x)
    if (Number.isFinite(canvasW)) tagX = Math.max(0, Math.min(tagX, canvasW - tagW))
    const tagY = Math.max(0, y - tagH < 0 ? y : y - tagH)
    ctx.fillStyle = color
    ctx.fillRect(tagX, tagY, tagW, tagH)
    ctx.fillStyle = TAG_TEXT
    ctx.fillText(text, tagX + pad, tagY + tagH / 2)
    ctx.restore()
  }
}

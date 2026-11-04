// Synthetic pan with ground truth: a seeded cylindrical world image seen through a virtual rotating camera.
// Same conventions as core/stitch/geometry.js (x right, y down, z forward; R = rotY(yaw)·rotX(pitch)·rotZ(roll)
// maps camera rays to world rays), and the same cylinder mapping as cylProject, offset by (u0, v0).
import { rotX, rotY, rotZ, mul, apply } from '../../core/stitch/geometry.js'
import { focalPx } from '../../core/stitch/camera-model.js'
import { Mp4Encoder } from '../../shared/encoder.js'

const RAD = Math.PI / 180

// mulberry32: small, fast, seeded.
function random(seed) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Scene pixels, read once per scene canvas.
const pixelCache = new WeakMap()

function scenePixels(canvas) {
  let data = pixelCache.get(canvas)
  if (!data) {
    data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data
    pixelCache.set(canvas, data)
  }
  return data
}

// A cylindrical world image f·Δθ wide, rich in ORB features: seeded rectangles, circles and lines in several sizes,
// colours and greys, over a soft gradient. (u0, v0) is yaw 0 at the horizon.
export function makeScene({ seed = 1, f, yawRange = [-60, 200], height = Math.round(2 * f * Math.tan(30 * RAD)) } = {}) {
  if (!(f > 0)) throw new RangeError('makeScene needs a positive focal length f')
  const width = Math.round(f * (yawRange[1] - yawRange[0]) * RAD)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rnd = random(seed)

  const grad = ctx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, 'rgb(150,170,190)')
  grad.addColorStop(0.5, 'rgb(190,175,150)')
  grad.addColorStop(1, 'rgb(140,160,150)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)

  const colour = () => {
    if (rnd() < 0.3) {
      const g = rnd() * 255 | 0
      return `rgb(${g},${g},${g})`
    }
    return `rgb(${rnd() * 255 | 0},${rnd() * 255 | 0},${rnd() * 255 | 0})`
  }
  // Large shapes first, so the small detail drawn last stays visible.
  const tiers = [[60, 160, 1 / 20000], [15, 60, 1 / 4000], [3, 15, 1 / 1500]]
  for (const [minSize, maxSize, density] of tiers) {
    const count = Math.round(width * height * density)
    for (let i = 0; i < count; i++) {
      const x = rnd() * width, y = rnd() * height
      const size = minSize + rnd() * (maxSize - minSize)
      const kind = rnd()
      ctx.fillStyle = colour()
      ctx.strokeStyle = colour()
      if (kind < 0.45) {
        ctx.fillRect(x, y, size, size * (0.4 + rnd() * 1.2))
      } else if (kind < 0.8) {
        ctx.beginPath()
        ctx.arc(x, y, size / 2, 0, 2 * Math.PI)
        ctx.fill()
      } else {
        const a = rnd() * Math.PI
        ctx.lineWidth = 1 + rnd() * Math.max(1, size / 10)
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + Math.cos(a) * size * 2, y + Math.sin(a) * size * 2)
        ctx.stroke()
      }
    }
  }
  return { canvas, f, u0: -yawRange[0] * RAD * f, v0: height / 2 }
}

// The view of a width x height camera with focal f (cx = width/2, cy = height/2) at the given orientation.
// Each pixel's ray d = R·K^-1·[x, y, 1] maps to u = f·atan2(d.x, d.z) + u0, v = f·d.y / hypot(d.x, d.z) + v0,
// bilinearly sampled (clamped at the scene edges) and multiplied by brightness.
export function renderView(scene, { yawDeg, pitchDeg = 0, rollDeg = 0, width, height, brightness = 1 }) {
  const { f, u0, v0 } = scene
  const sw = scene.canvas.width, sh = scene.canvas.height
  const src = scenePixels(scene.canvas)
  const R = mul(rotY(yawDeg), mul(rotX(pitchDeg), rotZ(rollDeg)))
  const cx = width / 2, cy = height / 2
  const out = new OffscreenCanvas(width, height)
  const ctx = out.getContext('2d', { willReadFrequently: true })
  const img = ctx.createImageData(width, height)
  const dst = img.data
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = apply(R, [(x - cx) / f, (y - cy) / f, 1])
      const u = Math.min(sw - 1, Math.max(0, f * Math.atan2(d[0], d[2]) + u0))
      const v = Math.min(sh - 1, Math.max(0, f * d[1] / Math.hypot(d[0], d[2]) + v0))
      const x0 = Math.min(sw - 2, Math.floor(u)), y0 = Math.min(sh - 2, Math.floor(v))
      const ax = u - x0, ay = v - y0
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4
      const o = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + ax * (src[i10 + c] - src[i00 + c])
        const bottom = src[i01 + c] + ax * (src[i11 + c] - src[i01 + c])
        dst[o + c] = (top + ay * (bottom - top)) * brightness
      }
      dst[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return out
}

// An MP4 of one rendered view per yaw (degrees), frame i at t = i / fps.
export async function panClip({ yaws, pitchDeg = 2, width = 640, height = 360, lens = 'wide', fps = 30 }) {
  const scene = makeScene({ f: focalPx({ lens, width, height }) })
  const encoder = await Mp4Encoder.create({ width, height, fps })
  try {
    for (const [i, yawDeg] of yaws.entries()) {
      await encoder.addFrame(renderView(scene, { yawDeg, pitchDeg, width, height }), i / fps)
    }
    return await encoder.finish()
  } catch (err) {
    encoder.abort()
    throw err
  }
}

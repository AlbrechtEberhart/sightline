// YOLO11 detector: letterbox preprocessing, ORT inference, decode + NMS, boxes in source pixels.
// The caller supplies model bytes; nothing here fetches.
import { ort } from '../../shared/lib/ort.js'
import { createSession } from '../../shared/models.js'
import { letterbox, toSource } from './letterbox.js'
import { decode } from './decode.js'
import { nms } from './nms.js'
import { COCO_LABELS } from './labels.js'

const PAD_COLOR = 'rgb(114,114,114)'
const WARMUP_RUNS = 3

// Reusable preprocessing state: one canvas and one tensor buffer per detector (live loop, no per-frame allocs).
function createScratch(size) {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return { size, canvas, ctx, data: new Float32Array(3 * size * size) }
}

// Draws `image` letterboxed onto a size x size canvas padded with grey and returns
// RGB, CHW order, float32 scaled 0-1. `scratch` (from createScratch) lets callers reuse buffers;
// the returned `data` is then the scratch buffer and is overwritten by the next call.
export function preprocess(image, size, scratch = createScratch(size)) {
  const srcW = image.displayWidth ?? image.width
  const srcH = image.displayHeight ?? image.height
  const lb = letterbox(srcW, srcH, size)
  const { ctx, data } = scratch
  ctx.fillStyle = PAD_COLOR
  ctx.fillRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, lb.padX, lb.padY, lb.newW, lb.newH)
  const rgba = ctx.getImageData(0, 0, size, size).data
  const plane = size * size
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    data[i] = rgba[p] / 255
    data[plane + i] = rgba[p + 1] / 255
    data[2 * plane + i] = rgba[p + 2] / 255
  }
  return { data, lb }
}

// Model output [1, 84, n] -> NMS'd boxes in source pixels. Boxes that fall entirely
// outside the source image (zero width or height after clamping) are dropped.
export function postprocess(output, n, lb, srcW, srcH, { conf = 0.35, iou = 0.45 } = {}) {
  const out = []
  for (const c of nms(decode(output, n, conf), iou)) {
    const box = toSource(c.box, lb, srcW, srcH)
    if (box[2] <= 0 || box[3] <= 0) continue
    out.push({ classId: c.classId, label: COCO_LABELS[c.classId], score: c.score, box })
  }
  return out
}

export async function createDetector({ modelBytes, inputSize, backend = 'auto' }) {
  const { session, backend: used } = await createSession(modelBytes, { backend })
  const scratch = createScratch(inputSize)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const run = (data) => session.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, inputSize, inputSize]) })

  // Warm-up on a blank (grey) input so shader compilation / allocation is not billed to the first frame.
  scratch.data.fill(114 / 255)
  let total = 0
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const t0 = performance.now()
    await run(scratch.data)
    total += performance.now() - t0
  }
  const warmupMs = total / WARMUP_RUNS

  // The scratch buffers are shared, so calls are serialized.
  let queue = Promise.resolve()
  async function detectOne(image, opts) {
    const srcW = image.displayWidth ?? image.width
    const srcH = image.displayHeight ?? image.height
    const { data, lb } = preprocess(image, inputSize, scratch)
    const results = await run(data)
    const output = results[outputName]
    return postprocess(output.data, output.dims[2], lb, srcW, srcH, opts)
  }

  return {
    backend: used,
    inputSize,
    warmupMs,
    detect(image, opts = {}) {
      const p = queue.then(() => detectOne(image, opts))
      queue = p.catch(() => {})
      return p
    },
    dispose() { session.release() },
  }
}

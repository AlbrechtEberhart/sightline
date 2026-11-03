// YOLO11 output decoding. Pure functions, no DOM, no I/O.
// Input is the model output [1, 84, n] in channel-major layout: data[c*n + i].
// Channels 0-3 are cx, cy, w, h in input pixels; channels 4-83 are the 80 class scores.

const NUM_CLASSES = 80
const FIRST_CLASS_CHANNEL = 4

// Returns one candidate per anchor whose top class score is >= conf.
// Boxes are [x, y, w, h] in input pixels with a top-left origin.
export function decode(data, n, conf) {
  const out = []
  for (let i = 0; i < n; i++) {
    let best = -Infinity
    let classId = -1
    for (let k = 0; k < NUM_CLASSES; k++) {
      const s = data[(FIRST_CLASS_CHANNEL + k) * n + i]
      if (s > best) { best = s; classId = k }
    }
    if (best < conf) continue
    const cx = data[0 * n + i]
    const cy = data[1 * n + i]
    const w = data[2 * n + i]
    const h = data[3 * n + i]
    out.push({ classId, score: best, box: [cx - w / 2, cy - h / 2, w, h] })
  }
  return out
}

// Non-maximum suppression. Pure functions, no DOM, no I/O.
// Boxes are [x, y, w, h] with top-left origin.

// Intersection over union of two [x, y, w, h] boxes. Returns 0 when the union is empty.
export function iouOf(a, b) {
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
  const inter = ix * iy
  const union = aw * ah + bw * bh - inter
  return union > 0 ? inter / union : 0
}

// Per-class greedy NMS. Suppresses a box when a higher-scoring box of the same class
// overlaps it with IoU above the threshold. Returns a new array sorted by score
// descending; the input array is not mutated.
export function nms(boxes, iou) {
  const sorted = [...boxes].sort((p, q) => q.score - p.score)
  const kept = []
  for (const cand of sorted) {
    const suppressed = kept.some(k => k.classId === cand.classId && iouOf(k.box, cand.box) > iou)
    if (!suppressed) kept.push(cand)
  }
  return kept
}

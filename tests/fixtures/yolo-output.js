// Synthetic YOLO11 output tensor [1, 84, n] in channel-major layout: data[c*n + i].
// Channels 0-3 are cx, cy, w, h in input pixels; channels 4-83 are class scores.
export function makeOutput(n, candidates) {
  if (candidates.length > n) throw new Error(`makeOutput: ${candidates.length} candidates exceed n=${n}`)
  const data = new Float32Array(84 * n)
  candidates.forEach((cand, i) => {
    data[0 * n + i] = cand.cx
    data[1 * n + i] = cand.cy
    data[2 * n + i] = cand.w
    data[3 * n + i] = cand.h
    for (const [k, s] of Object.entries(cand.scores)) data[(4 + Number(k)) * n + i] = s
  })
  return data
}

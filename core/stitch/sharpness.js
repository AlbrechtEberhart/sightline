// Focus measure: variance of the 4-neighbour Laplacian over interior pixels. Pure maths.
// Higher means sharper. Only comparable between thumbnails of similar size.

export function sharpness({ data, width, height }) {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const lap = data[i - 1] + data[i + 1] + data[i - width] + data[i + width] - 4 * data[i]
      sum += lap
      sumSq += lap * lap
      n++
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

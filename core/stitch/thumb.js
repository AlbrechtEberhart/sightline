// Grey (luma) thumbnails for cheap image measurements. Needs OffscreenCanvas; nothing else.

// Intrinsic size of any CanvasImageSource (VideoFrame, video, bitmap, canvas, img).
function sourceSize(image) {
  const width = image.displayWidth ?? image.videoWidth ?? image.naturalWidth ?? image.width
  const height = image.displayHeight ?? image.videoHeight ?? image.naturalHeight ?? image.height
  return { width, height }
}

// Returns { data: Float32Array luma 0-255, width, height, scale } where scale = thumbWidth / imageWidth.
export function toThumb(image, maxWidth = 256) {
  const { width: srcW, height: srcH } = sourceSize(image)
  if (!(srcW > 0 && srcH > 0)) throw new TypeError('toThumb: image has no size')
  const width = Math.max(1, Math.min(maxWidth, srcW))
  const height = Math.max(1, Math.round(srcH * width / srcW))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, width, height)
  const rgba = ctx.getImageData(0, 0, width, height).data
  const data = new Float32Array(width * height)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
  }
  return { data, width, height, scale: width / srcW }
}

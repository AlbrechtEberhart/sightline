// Review overlay for the Recorded app: a <video> of the original clip (object-fit: contain)
// with a canvas on top that redraws the stored boxes for the frame being shown.
//
// The <video> element applies the file's rotation matrix itself, so its picture is upright
// and matches meta.width x meta.height, the same space the boxes are in.
import { fitContain, drawDetections } from '../../shared/draw-boxes.js'
import { frameIndexAt } from './process.js'

/**
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas positioned over the video, same CSS box
 */
export function createReview(video, canvas) {
  const ctx = canvas.getContext('2d')
  const hasVfc = typeof video.requestVideoFrameCallback === 'function'
  let data = null // { result, meta, showLabels }
  let lastTime = 0
  let vfc = 0

  function draw(t = lastTime) {
    lastTime = t
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(canvas.clientWidth * dpr)
    const h = Math.round(canvas.clientHeight * dpr)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.clearRect(0, 0, w, h)
    if (!data || !w || !h) return
    const { result, meta, showLabels } = data
    // The element's clock is the movie timeline; frame times start at the first frame.
    const origin = meta.origin ?? 0
    const boxes = result.detections[frameIndexAt(result.times, t - origin)] || []
    drawDetections(ctx, boxes, { ...fitContain(meta.width, meta.height, w, h), showLabels, dpr })
  }

  function onFrame(_now, metadata) {
    if (!data) return
    draw(metadata.mediaTime)
    vfc = video.requestVideoFrameCallback(onFrame)
  }

  const redrawCurrent = () => { if (data) draw(video.currentTime) }
  if (!hasVfc) video.addEventListener('timeupdate', redrawCurrent)
  video.addEventListener('seeked', redrawCurrent)
  video.addEventListener('loadeddata', redrawCurrent)
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => draw()).observe(canvas)
  else window.addEventListener('resize', () => draw())

  return {
    /** Shows `url` with the boxes of a completed processClip `result`. */
    show(url, result, meta, showLabels) {
      data = { result, meta, showLabels }
      lastTime = 0
      if (video.src !== url) video.src = url
      if (hasVfc) {
        if (vfc) video.cancelVideoFrameCallback(vfc)
        vfc = video.requestVideoFrameCallback(onFrame)
      }
      draw(video.currentTime)
    },
    hide() {
      data = null
      if (vfc && hasVfc) video.cancelVideoFrameCallback(vfc)
      vfc = 0
      video.pause()
      draw()
    },
    /** Detaches the clip (before choosing another one). */
    clear() {
      this.hide()
      video.removeAttribute('src')
      video.load()
    },
  }
}

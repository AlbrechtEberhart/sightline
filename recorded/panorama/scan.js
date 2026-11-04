// Studio panorama scan: reads a recorded clip forward once, asks the frame picker which sharp frames each add new
// scene, and hands those frames to the stitcher. Only the frames the picker holds are kept as ImageBitmaps, downscaled
// to at most 1920 px on the long side (photoSize).
// When the page is hidden the current decoder run is ended (iOS reclaims the decoder on suspend); the picker, the held
// bitmaps and the previous thumbnail are kept, and the scan resumes at the next frame once the page is visible.
import { toThumb } from '../../core/stitch/thumb.js'
import { sharpness } from '../../core/stitch/sharpness.js'
import { phaseShift } from '../../core/stitch/shift.js'
import { createFramePicker } from '../../core/stitch/select.js'
import { photoSize, photoBitmap } from '../../core/stitch/stitcher.js'

const MAX_PHOTOS = 12
const abortError = () => new DOMException('Cancelled', 'AbortError')

const pageVisibility = {
  hidden: () => document.hidden,
  // Resolves when the page is visible again, or when `signal` aborts.
  whenVisible: (signal) => new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', check)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const check = () => { if (!document.hidden) done() }
    if (!document.hidden || signal?.aborted) return resolve()
    document.addEventListener('visibilitychange', check)
    signal?.addEventListener('abort', done)
  }),
}

/**
 * @param source FileVideoSource
 * @param opts.stitcher a created studio Stitcher, sized photoSize(source.meta); picks are added to it as they are found
 * @param opts.onProgress (fraction 0..1) as frames are read
 * @param opts.onPick (bitmap) called just before a pick is handed to the stitcher (the bitmap is transferred after)
 * @param opts.signal AbortSignal: closes every held bitmap and throws an AbortError
 * @param opts.visibility { hidden(), whenVisible(signal) } page visibility (defaults to the document's)
 * @returns {Promise<{ used: number[], messages: string[], error: string | null }>}
 *   On error ('Not enough panning') the picks already sent to the stitcher are still in the worker:
 *   the caller must cancel the stitcher and not stitch.
 */
export async function scanClip(source, { stitcher, onProgress, onPick, signal, visibility = pageVisibility } = {}) {
  const { width, frameCount, duration } = source.meta
  const size = photoSize(source.meta) // held frames are downscaled to the size the stitcher was created with
  const picker = createFramePicker({ width, maxPhotos: MAX_PHOTOS })
  const held = new Map() // frame index -> ImageBitmap
  const used = []
  let prev = null
  let next = 0 // the first frame the next decoder run should yield
  let sawHidden = false
  const onVisibility = () => { if (visibility.hidden()) sawHidden = true }

  const closeAll = () => { for (const b of held.values()) b.close(); held.clear() }
  const send = (index) => {
    const bitmap = held.get(index)
    held.delete(index)
    used.push(index)
    onPick?.(bitmap)
    stitcher.add(bitmap) // transfers the bitmap
  }

  try {
    if (signal?.aborted) throw abortError()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    for (let finished = false; !finished;) {
      let paused = false
      sawHidden = visibility.hidden()
      try {
        for await (const { image, t, index } of source.frames({ startFrame: next })) {
          try {
            if (signal?.aborted) throw abortError()
            const thumb = toThumb(image)
            const dx = prev ? phaseShift(prev, thumb).dx / thumb.scale : 0 // full-resolution pixels
            prev = thumb
            next = index + 1
            const r = picker.push({ index, dx, sharpness: sharpness(thumb) })
            if (r.hold) held.set(index, await photoBitmap(image, size))
            for (const i of r.release) { held.get(i)?.close(); held.delete(i) }
            if (r.pick !== null && r.pick !== undefined) send(r.pick)
            onProgress?.(frameCount > 0 ? (index + 1) / frameCount : duration > 0 ? Math.min(1, t / duration) : 0)
          } finally {
            image.close()
          }
          if (used.length >= MAX_PHOTOS) { finished = true; break } // the picker ignores everything after its last pick
          if (visibility.hidden()) { paused = true; break }
        }
        if (!paused) finished = true
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err
        if (!(sawHidden || visibility.hidden())) throw err // a decoder error while hidden is the suspend: resume
        paused = true
      }
      if (paused && !finished) {
        await visibility.whenVisible(signal)
        if (signal?.aborted) throw abortError()
      }
    }
    if (signal?.aborted) throw abortError()
    const end = picker.finish()
    for (const i of end.release) { held.get(i)?.close(); held.delete(i) }
    if (end.error) return { used, messages: end.messages, error: end.error }
    for (const i of end.picks) send(i)
    if (used.length < 2) return { used, messages: end.messages, error: 'Not enough panning' }
    return { used, messages: end.messages, error: null }
  } finally {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    closeAll()
  }
}

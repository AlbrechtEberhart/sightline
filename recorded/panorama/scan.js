// Studio panorama scan: reads a recorded clip forward once, asks the frame picker which sharp frames each add new
// scene, and hands those frames to the stitcher. Only the frames the picker holds are kept as ImageBitmaps.
import { toThumb } from '../../core/stitch/thumb.js'
import { sharpness } from '../../core/stitch/sharpness.js'
import { phaseShift } from '../../core/stitch/shift.js'
import { createFramePicker } from '../../core/stitch/select.js'

const abortError = () => new DOMException('Cancelled', 'AbortError')

/**
 * @param source FileVideoSource
 * @param opts.stitcher a created studio Stitcher; picks are added to it as they are found
 * @param opts.onProgress (fraction 0..1) as frames are read
 * @param opts.onPick (bitmap) called just before a pick is handed to the stitcher (the bitmap is transferred after)
 * @param opts.signal AbortSignal: closes every held bitmap and throws an AbortError
 * @returns {Promise<{ used: number[], messages: string[], error: string | null }>}
 *   On error ('Not enough panning') the picks already sent to the stitcher are still in the worker:
 *   the caller must cancel the stitcher and not stitch.
 */
export async function scanClip(source, { stitcher, onProgress, onPick, signal } = {}) {
  const { width, frameCount, duration } = source.meta
  const picker = createFramePicker({ width })
  const held = new Map() // frame index -> ImageBitmap
  const used = []
  let prev = null

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
    for await (const { image, t, index } of source.frames()) {
      try {
        if (signal?.aborted) throw abortError()
        const thumb = toThumb(image)
        const dx = prev ? phaseShift(prev, thumb).dx / thumb.scale : 0 // full-resolution pixels
        prev = thumb
        const r = picker.push({ index, dx, sharpness: sharpness(thumb) })
        if (r.hold) held.set(index, await createImageBitmap(image))
        for (const i of r.release) { held.get(i)?.close(); held.delete(i) }
        if (r.pick !== null && r.pick !== undefined) send(r.pick)
        onProgress?.(frameCount > 0 ? (index + 1) / frameCount : duration > 0 ? Math.min(1, t / duration) : 0)
      } finally {
        image.close()
      }
    }
    if (signal?.aborted) throw abortError()
    const end = picker.finish()
    for (const i of end.release) { held.get(i)?.close(); held.delete(i) }
    if (end.error) return { used, messages: end.messages, error: end.error }
    for (const i of end.picks) send(i)
    return { used, messages: end.messages, error: null }
  } finally {
    closeAll()
  }
}

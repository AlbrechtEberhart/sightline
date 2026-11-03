// Annotated export for the Recorded app: re-decode the clip, draw each frame plus its
// stored boxes onto a canvas, re-encode to H.264 and pass the original AAC audio through.
import { FileVideoSource } from '../video-source.js'
import { Mp4Encoder, capTo1080 } from '../../shared/encoder.js'
import { drawDetections } from '../../shared/draw-boxes.js'

function abortError() {
  return new DOMException('Export cancelled', 'AbortError')
}

/**
 * @param {Blob} blob the original clip
 * @param {Array<object[] | null>} detections boxes per frame index, in source (upright) pixels
 * @param {{ showLabels?: boolean, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<Blob>} the annotated MP4. Rejects with AbortError when `signal` fires;
 *   the encoder is aborted on any failure.
 */
export async function exportClip(blob, detections, { showLabels = true, signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError()
  const source = await FileVideoSource.open(blob)
  const { meta } = source
  let encoder = null
  const onAbort = () => { encoder?.abort(); source.stop() }
  signal?.addEventListener('abort', onAbort)
  try {
    const audio = await source.readAudio()
    const { chunks = [], ...audioConfig } = audio || {}
    const out = capTo1080(meta.width, meta.height)
    encoder = await Mp4Encoder.create({ ...out, fps: meta.fps, audio: audio ? audioConfig : undefined })
    if (signal?.aborted) throw abortError()

    const canvas = new OffscreenCanvas(encoder.width, encoder.height)
    const ctx = canvas.getContext('2d')
    // capTo1080 keeps the aspect ratio, so one scale maps source pixels to output pixels.
    const scale = canvas.width / meta.width
    for await (const { image, t, index } of source.frames()) {
      try {
        if (signal?.aborted) break
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        drawDetections(ctx, detections[index] ?? [], { scale, offsetX: 0, offsetY: 0, showLabels, dpr: 1 })
        await encoder.addFrame(canvas, t)
      } finally {
        image.close()
      }
      if (onProgress) {
        try { onProgress(index + 1, meta.frameCount) } catch (e) { console.warn('exportClip: onProgress threw', e) }
      }
    }
    if (signal?.aborted) throw abortError()

    if (audio && chunks.length) encoder.addAudioChunks(chunks)
    return await encoder.finish()
  } catch (err) {
    encoder?.abort()
    if (signal?.aborted) throw abortError()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    source.stop()
  }
}

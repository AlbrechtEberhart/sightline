// Offline clip processing for the Recorded app: decode every frame of a
// FileVideoSource, run the detector, keep only the boxes. Resumable (startFrame +
// prior), cancellable (AbortSignal) and tolerant of decoder/detector failures:
// processClip never rejects, it resolves with completed: false and the last
// frame whose boxes are fully stored.

/** Seconds to process `frameCount` frames at `step` when one detect takes `msPerFrame`. */
export function estimateSeconds(frameCount, step, msPerFrame) {
  return (frameCount / step) * msPerFrame / 1000
}

/** Frames each label appears in (once per frame), most frames first, ties by label. */
export function summarize(detections) {
  const counts = new Map()
  for (const boxes of detections) {
    if (!boxes) continue
    for (const label of new Set(boxes.map((b) => b.label))) counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts].map(([label, frames]) => ({ label, frames }))
    .sort((a, b) => b.frames - a.frames || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

/** Index of the entry in the ascending, dense `times` array nearest to `t`. */
export function frameIndexAt(times, t) {
  if (!times.length) return 0
  let lo = 0, hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && t - times[lo - 1] <= times[lo] - t) return lo - 1
  return lo
}

/**
 * @param {{ meta: { frameCount: number }, frames: Function, stop: Function }} source
 * @param {{ detect: Function }} detector
 * @param {{ step?: number, conf?: number, iou?: number, startFrame?: number,
 *   prior?: { detections: any[], times: any[] } | null, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number, etaSeconds: number) => void }} [opts]
 * @returns {Promise<{ detections: Array<object[] | null>, times: Array<number | null>,
 *   completed: boolean, lastFrame: number, error?: Error }>}
 */
export async function processClip(source, detector, opts = {}) {
  const { conf = 0.35, iou = 0.45, prior = null, signal, onProgress } = opts
  const step = Math.max(1, Math.floor(opts.step) || 1)
  const frameCount = source.meta.frameCount
  const startFrame = Math.min(frameCount, Math.max(0, Math.floor(opts.startFrame) || 0))
  const total = frameCount - startFrame

  const detections = new Array(frameCount).fill(null)
  const times = new Array(frameCount).fill(null)
  if (prior) {
    for (let i = 0; i < startFrame; i++) {
      detections[i] = prior.detections?.[i] ?? null
      times[i] = prior.times?.[i] ?? null
    }
  }

  let lastFrame = startFrame - 1
  let current = null // most recent processed array, reused by skipped frames
  let done = 0, processed = 0, warned = false, error
  const began = performance.now()

  try {
    if (signal?.aborted) return { detections, times, completed: false, lastFrame }
    for await (const { image, t, index } of source.frames({ startFrame })) {
      try {
        if (index < startFrame || index >= frameCount) continue
        if ((index - startFrame) % step === 0 || current === null) {
          current = await detector.detect(image, { conf, iou })
          processed++
        }
        detections[index] = current
        times[index] = t
        lastFrame = index
        done++
      } finally {
        image.close()
      }
      let eta = NaN
      if (processed > 0) {
        const msPerFrame = (performance.now() - began) / processed
        eta = estimateSeconds(Math.ceil((total - done) / step), 1, msPerFrame)
      }
      if (onProgress) {
        try { onProgress(done, total, eta) } catch (e) {
          if (!warned) { warned = true; console.warn('processClip: onProgress threw', e) }
        }
      }
      if (signal?.aborted) break
    }
  } catch (e) {
    error = e // decoder or detector failure: keep what is stored
  } finally {
    try { source.stop() } catch (e) { console.warn('processClip: source.stop threw', e) }
  }

  if (!error && !signal?.aborted && lastFrame < frameCount - 1) {
    // Decoder ended cleanly early: not a cancel, so the caller must not resume forever.
    error = new Error(`decoder ended at frame ${lastFrame + 1} of ${frameCount}`)
    error.name = 'TruncatedClipError'
  }
  const completed = !error && lastFrame === frameCount - 1
  const result = { detections, times, completed, lastFrame }
  if (error) result.error = error
  return result
}

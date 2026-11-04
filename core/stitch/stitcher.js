// Page-side client for the panorama stitch worker (stitch-worker.js, protocol in its header).
//   const s = await Stitcher.create({ opencvBytes, focalPx, width, height, mode: 'live' | 'studio', onProgress })
//   s.add(bitmap, { yawHint })   // bitmap is transferred; yawHint in degrees, Live only
//   const { blob, width, height, notes, used, yaws, rolls } = await s.finish()
//   s.cancel()                   // terminates the worker; finish() rejects with an AbortError
// onProgress(stage: 'match' | 'warp' | 'blend' | 'encode', done, total).
// The worker is terminated once finish settles, on any error, and on cancel; later adds just close their bitmap.

const READY_TIMEOUT_MS = 60000

function namedError(name, message) {
  const e = new Error(message)
  e.name = name
  return e
}

export class Stitcher {
  #worker
  #onProgress
  #closed = false
  #error = null
  #finish = null // { promise, resolve, reject } once finish() is called

  // Rejects with an Error named 'OpenCVError' if the worker or OpenCV.js does not start within 60 s.
  // A copy of opencvBytes is transferred, so the caller can create further stitchers from the same bytes.
  static async create({ opencvBytes, focalPx, width, height, mode, onProgress } = {}) {
    if (mode !== 'live' && mode !== 'studio') throw new TypeError(`mode must be 'live' or 'studio', got ${mode}`)
    if (!(focalPx > 0 && width > 0 && height > 0)) throw new RangeError('focalPx, width and height must be positive')
    const copy = opencvBytes.slice()
    const buffer = copy.buffer ?? copy // Uint8Array or ArrayBuffer
    const worker = new Worker(new URL('./stitch-worker.js', import.meta.url), { type: 'module' })
    try {
      await new Promise((resolve, reject) => {
        const settle = (fn, value) => {
          clearTimeout(timer)
          worker.onmessage = worker.onerror = null
          fn(value)
        }
        const timer = setTimeout(() => settle(reject, namedError('OpenCVError', 'OpenCV did not start within 60 s')),
          READY_TIMEOUT_MS)
        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') settle(resolve)
          else if (data.type === 'error') settle(reject, namedError('OpenCVError', data.message))
        }
        worker.onerror = (e) => {
          e.preventDefault()
          settle(reject, namedError('OpenCVError', e.message || 'The stitch worker failed to start'))
        }
        worker.postMessage({ type: 'init', opencvBytes: buffer, focalPx, width, height, mode }, [buffer])
      })
    } catch (err) {
      worker.terminate()
      throw err
    }
    return new Stitcher(worker, onProgress)
  }

  // Use Stitcher.create.
  constructor(worker, onProgress) {
    this.#worker = worker
    this.#onProgress = onProgress
    worker.onmessage = ({ data }) => this.#message(data)
    worker.onerror = (e) => {
      e.preventDefault()
      this.#fail(namedError('Error', e.message || 'The stitch worker failed'))
    }
  }

  #message(data) {
    if (data.type === 'progress') {
      this.#onProgress?.(data.stage, data.done, data.total)
    } else if (data.type === 'result') {
      const { type, ...result } = data
      this.#close()
      this.#finish.resolve(result)
    } else if (data.type === 'error') {
      this.#fail(namedError(data.name, data.message))
    }
  }

  #close() {
    this.#closed = true
    this.#worker.terminate()
  }

  #fail(err) {
    if (this.#closed) return
    this.#error = err
    this.#close()
    this.#finish?.reject(err)
  }

  add(bitmap, { yawHint } = {}) {
    if (this.#closed || this.#finish) {
      bitmap.close()
      return
    }
    this.#worker.postMessage({ type: 'add', bitmap, yawHint }, [bitmap])
  }

  // Same promise on every call. Rejects with the worker's error (name 'StitchError' when too few photos matched).
  finish() {
    if (!this.#finish) {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      this.#finish = { promise, resolve, reject }
      if (this.#error) reject(this.#error)
      else this.#worker.postMessage({ type: 'finish' })
    }
    return this.#finish.promise
  }

  cancel() {
    this.#fail(new DOMException('Cancelled', 'AbortError'))
  }
}

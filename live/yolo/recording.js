// Annotated recording for Live: draws each detected frame plus its boxes onto an
// OffscreenCanvas and feeds that to the MP4 encoder. No DOM, no UI.
import { Mp4Encoder, capTo1080 } from '../../shared/encoder.js'
import { drawDetections } from '../../shared/draw-boxes.js'

export class Recorder {
  constructor() {
    this.encoder = null
    this.active = false
    this._busy = Promise.resolve() // the addFrame in flight, if any
    this._canvas = null
    this._ctx = null
    this._t0 = null
    this.elapsed = 0 // seconds of the last frame added
  }

  /** @param {{ width: number, height: number, fps: number }} meta */
  async start({ width, height, fps }) {
    const size = capTo1080(width, height)
    this.encoder = await Mp4Encoder.create({ ...size, fps })
    this._canvas = new OffscreenCanvas(size.width, size.height)
    this._ctx = this._canvas.getContext('2d')
    this._t0 = null
    this.elapsed = 0
    this.active = true
  }

  /**
   * Draws `image` and `boxes` onto the recording canvas and encodes it. Does not close
   * `image`. Resolves once the frame is queued (the encoder applies back-pressure).
   */
  addFrame(image, boxes, t, showLabels) {
    if (!this.active) return Promise.resolve()
    const run = async () => {
      if (!this.active) return
      const { width: w, height: h } = this._canvas
      const srcW = image.displayWidth ?? image.width
      this._ctx.drawImage(image, 0, 0, w, h)
      drawDetections(this._ctx, boxes, { scale: w / srcW, showLabels, dpr: Math.max(1, Math.min(w, h) / 390) })
      this._t0 ??= t
      this.elapsed = t - this._t0
      await this.encoder.addFrame(this._canvas, this.elapsed)
    }
    this._busy = run()
    return this._busy
  }

  /** Stops accepting frames, flushes the encoder and returns the MP4 Blob. */
  async stop() {
    this.active = false
    const encoder = this.encoder
    try { await this._busy } catch { /* surfaced by finish() */ }
    try {
      return await encoder.finish()
    } finally {
      if (this.encoder === encoder) this.encoder = null
    }
  }

  /** Drops the recording and releases the hardware encoder. Idempotent. */
  abort() {
    this.active = false
    this.encoder?.abort()
    this.encoder = null
  }
}

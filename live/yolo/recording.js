// Annotated recording for Live: draws each detected frame plus its boxes onto an
// OffscreenCanvas and feeds that to the MP4 encoder. No DOM, no UI.
//
// The encoder and canvas are sized from the first recorded frame (displayWidth/displayHeight,
// capped by capTo1080), not from the camera's reported size, so a stream that rotates or
// reports a different size cannot stretch the clip. If a later frame has a different display
// size, addFrame resolves 'resized' and the caller should stop the recording.
import { Mp4Encoder, capTo1080 } from '../../shared/encoder.js'
import { drawDetections, strokeScale } from '../../shared/draw-boxes.js'

export class Recorder {
  constructor() {
    this.encoder = null
    this.active = false
    this.elapsed = 0 // seconds of the last frame added
    this._gen = 0 // bumped by arm() and abort(): an encoder created for an old generation is dropped
    this._busy = Promise.resolve() // the addFrame in flight, if any
    this._fps = 30
    this._canvas = null
    this._ctx = null
    this._frameW = 0
    this._frameH = 0
    this._t0 = null
  }

  /** True once the first frame has created the encoder. */
  get ready() { return !!this.encoder }

  /** Starts accepting frames. Synchronous: the encoder is created on the first frame. */
  arm(fps) {
    this._gen++
    this.encoder = null
    this._fps = fps
    this._t0 = null
    this.elapsed = 0
    this.active = true
  }

  /**
   * Draws `image` and `boxes` onto the recording canvas and encodes it. Does not close `image`.
   * Resolves 'ok', 'skipped' (not recording, or aborted meanwhile) or 'resized' (the frame's
   * display size differs from the first frame's; nothing was encoded).
   * @returns {Promise<'ok'|'skipped'|'resized'>}
   */
  addFrame(image, boxes, t, showLabels) {
    if (!this.active) return Promise.resolve('skipped')
    this._busy = this._add(image, boxes, t, showLabels)
    return this._busy
  }

  async _add(image, boxes, t, showLabels) {
    const gen = this._gen
    const frameW = image.displayWidth ?? image.width
    const frameH = image.displayHeight ?? image.height
    if (!this.encoder) {
      const size = capTo1080(frameW, frameH)
      const encoder = await Mp4Encoder.create({ ...size, fps: this._fps })
      if (gen !== this._gen || !this.active) { encoder.abort(); return 'skipped' }
      this.encoder = encoder
      this._canvas = new OffscreenCanvas(size.width, size.height)
      this._ctx = this._canvas.getContext('2d')
      this._frameW = frameW
      this._frameH = frameH
      this._t0 = t
    } else if (frameW !== this._frameW || frameH !== this._frameH) {
      return 'resized'
    }
    const { width: w, height: h } = this._canvas
    this._ctx.drawImage(image, 0, 0, w, h)
    // capTo1080 keeps the aspect ratio, so one scale serves x and y.
    drawDetections(this._ctx, boxes, { scale: w / frameW, showLabels, dpr: strokeScale(w, h) })
    this.elapsed = t - this._t0
    await this.encoder.addFrame(this._canvas, this.elapsed)
    return 'ok'
  }

  /** Stops accepting frames, flushes the encoder and returns the MP4 Blob. */
  async stop() {
    this.active = false
    try { await this._busy } catch { /* surfaced by finish() */ }
    const encoder = this.encoder
    if (!encoder) throw new Error('No frames were recorded')
    try {
      return await encoder.finish()
    } finally {
      if (this.encoder === encoder) this.encoder = null
    }
  }

  /** Drops the recording and releases the hardware encoder. Idempotent. */
  abort() {
    this._gen++
    this.active = false
    this.encoder?.abort()
    this.encoder = null
  }
}

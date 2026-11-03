// WebCodecs H.264 encoder + mp4-muxer. Used by Live (canvas frames, real timestamps)
// and Recorded (re-encode frame by frame, AAC audio passed through unchanged).
import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.js'

const CODECS = ['avc1.640028', 'avc1.42E028'] // High 4.0, then Baseline 4.0
const KEYFRAME_INTERVAL_S = 2
const MAX_QUEUE = 4

const even = n => Math.max(2, Math.floor(n / 2) * 2)

// Scale down only: long side <= 1920, short side <= 1080, even dimensions.
export function capTo1080(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h)
  const s = Math.min(1, 1920 / long, 1080 / short)
  // Round before the even-floor so float error (e.g. 1079.9999) cannot lose 2px.
  return { width: even(Math.round(w * s)), height: even(Math.round(h * s)) }
}

function unsupported() {
  const e = new Error('H.264 encoding is not supported in this browser')
  e.name = 'EncoderUnsupportedError'
  return e
}

export class Mp4Encoder {
  static async create({ width, height, fps, audio } = {}) {
    if (typeof VideoEncoder === 'undefined') throw unsupported()
    width = even(width); height = even(height)
    const base = { width, height, bitrate: Math.round(width * height * fps * 0.1), framerate: fps, avc: { format: 'avc' } }
    let config = null
    for (const codec of CODECS) {
      const c = { ...base, codec }
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break } } catch { /* try next */ }
    }
    if (!config) throw unsupported()
    return new Mp4Encoder(config, audio)
  }

  constructor(config, audio) {
    this.config = config
    this.width = config.width; this.height = config.height
    this.codec = config.codec
    this.audio = audio || null
    this.audioMetaSent = false
    this.error = null
    this.lastKeyT = -Infinity
    this.target = new ArrayBufferTarget()
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: 'avc', width: this.width, height: this.height },
      audio: audio ? { codec: 'aac', numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } : undefined,
      fastStart: 'in-memory',
      // Keeps the audio/video alignment readAudio() produced: one shared zero for both tracks.
      firstTimestampBehavior: 'cross-track-offset',
    })
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => { try { this.muxer.addVideoChunk(chunk, meta) } catch (e) { this.#fail(e) } },
      error: e => this.#fail(e),
    })
    this.encoder.configure(config)
  }

  #fail(e) { if (!this.error) this.error = e }
  #check() { if (this.error) throw this.error }

  async addFrame(image, t) {
    this.#check()
    while (this.encoder.encodeQueueSize > MAX_QUEUE) {
      await new Promise(r => {
        const done = () => { this.encoder.removeEventListener('dequeue', done); clearTimeout(timer); r() }
        const timer = setTimeout(done, 20)
        this.encoder.addEventListener('dequeue', done)
      })
      this.#check()
    }
    const timestamp = Math.round(t * 1e6)
    const keyFrame = t - this.lastKeyT >= KEYFRAME_INTERVAL_S
    if (keyFrame) this.lastKeyT = t
    // Always wrap: a new VideoFrame leaves the caller's frame for the caller to close.
    const frame = new VideoFrame(image, { timestamp })
    try { this.encoder.encode(frame, { keyFrame }) } finally { frame.close() }
  }

  addAudioChunks(chunks) {
    this.#check()
    if (!this.audio) throw new Error('Mp4Encoder was created without audio')
    for (const c of chunks) {
      let meta
      if (!this.audioMetaSent) {
        this.audioMetaSent = true
        meta = { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: this.audio.numberOfChannels, sampleRate: this.audio.sampleRate, description: this.audio.description } }
      }
      this.muxer.addAudioChunkRaw(c.data, 'key', c.timestamp, c.duration, meta)
    }
  }

  async finish() {
    try { await this.encoder.flush() } catch (e) { this.#fail(e) }
    try { this.encoder.close() } catch { /* already closed after an error */ }
    this.#check()
    this.muxer.finalize()
    return new Blob([this.target.buffer], { type: 'video/mp4' })
  }
}

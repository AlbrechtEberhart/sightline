// WebCodecs H.264 encoder + mp4-muxer. Used by Live (canvas frames, real timestamps)
// and Recorded (re-encode frame by frame, AAC audio passed through unchanged).
import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.js'

// H.264 level by macroblock rate (MaxMBPS): 4.0 = 245760, 4.2 = 522240, else 5.1.
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

export function codecCandidates(width, height, fps) {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps
  if (mbps <= 245760) return ['avc1.640028', 'avc1.42E028'] // High / Baseline @ 4.0
  if (mbps <= 522240) return ['avc1.64002A', 'avc1.42E02A'] // @ 4.2
  return ['avc1.640033'] // High @ 5.1
}

function unsupported() {
  const e = new Error('H.264 encoding is not supported in this browser')
  e.name = 'EncoderUnsupportedError'
  return e
}

export class Mp4Encoder {
  static async create({ width, height, fps, audio } = {}) {
    if (typeof VideoEncoder === 'undefined') throw unsupported()
    if (!(Number.isFinite(fps) && fps > 0)) throw new TypeError('fps must be a positive finite number')
    width = even(width); height = even(height)
    const base = { width, height, bitrate: Math.round(width * height * fps * 0.1), framerate: fps, avc: { format: 'avc' } }
    let config = null
    for (const codec of codecCandidates(width, height, fps)) {
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
    this.finished = false
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
      output: (chunk, meta) => { try { this.muxer?.addVideoChunk(chunk, meta) } catch (e) { this.#fail(e) } },
      error: e => this.#fail(e),
    })
    this.encoder.configure(config)
  }

  #fail(e) { if (!this.error) this.error = e }
  #check() {
    if (this.finished) throw new Error('encoder already finished')
    if (this.error) throw this.error
  }

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
    if (this.finished) throw new Error('encoder already finished')
    try { await this.encoder.flush() } catch (e) { this.#fail(e) }
    if (this.finished) throw new Error('encoder already finished') // aborted while flushing
    this.finished = true
    try { this.encoder.close() } catch { /* already closed after an error */ }
    if (this.error) throw this.error
    this.muxer.finalize()
    return new Blob([this.target.buffer], { type: 'video/mp4' })
  }

  // Release the encoder and drop the muxer output. Idempotent, never throws.
  abort() {
    this.finished = true
    try { if (this.encoder.state !== 'closed') this.encoder.close() } catch { /* ignore */ }
    this.muxer = null; this.target = null
  }
}

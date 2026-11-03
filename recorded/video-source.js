// FileVideoSource: reads an MP4/MOV file with mp4box.js (demux) and WebCodecs
// VideoDecoder (decode). Implements the FrameSource interface in
// ../shared/frame-source.js: frames come upright, in presentation order, and the
// consumer closes every yielded `image`.
//
// mp4box parses only the header (moov). Sample bytes are then read straight from
// the Blob using mp4box's sample table (offset/size per sample), so memory stays
// bounded for long iPhone clips and `frames({ startFrame })` can seek to a
// keyframe without re-parsing the file.

import MP4Box from '../shared/lib/mp4box.js'

const SLICE = 1 << 20 // 1 MB: blob read size for parsing and for sample batches
const MAX_DECODE_QUEUE = 8
export const UNSUPPORTED_MESSAGE = "Can't decode this video. On iPhone set Camera → Formats → Most Compatible."

function namedError(name, message, cause) {
  const e = new Error(message, cause === undefined ? undefined : { cause })
  e.name = name
  return e
}

/**
 * Rejects with UnsupportedCodecError unless WebCodecs can decode `config`.
 * @param {VideoDecoderConfig} config
 */
export async function assertDecodable(config) {
  let supported = false
  try {
    if (typeof VideoDecoder !== 'undefined') supported = !!(await VideoDecoder.isConfigSupported(config)).supported
  } catch {
    supported = false // invalid codec strings throw TypeError in some browsers
  }
  if (!supported) throw namedError('UnsupportedCodecError', UNSUPPORTED_MESSAGE)
}

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

// Parse the container header. Resolves { file, info } or throws VideoOpenError.
async function parseHeader(blob) {
  const file = MP4Box.createFile() // discards mdat payloads; we read samples from the blob
  let info = null, failure = null
  file.onReady = (i) => { info = i }
  file.onError = (e) => { failure = e || 'parse error' }
  try {
    let offset = 0
    while (offset < blob.size && !failure) {
      const buf = await blob.slice(offset, Math.min(offset + SLICE, blob.size)).arrayBuffer()
      buf.fileStart = offset
      const next = file.appendBuffer(buf)
      // A fragmented file's sample table grows with each moof, so read it all.
      if (info && !info.isFragmented) break
      const end = offset + buf.byteLength
      offset = Number.isFinite(next) && next > end ? next : end // skip an mdat when mp4box asks to
    }
    file.flush()
  } catch (e) {
    failure = e
  }
  if (failure || !info) throw namedError('VideoOpenError', "Couldn't read this video file.", failure || undefined)
  if (!info.videoTracks || !info.videoTracks.length) throw namedError('VideoOpenError', 'This file has no video track.')
  return { file, info }
}

// tkhd matrix (16.16 fixed point) → clockwise display rotation 0|90|180|270.
function rotationFromMatrix(m) {
  if (!m || m.length < 2) return 0
  const deg = Math.round((Math.atan2(m[1] | 0, m[0] | 0) * 180) / Math.PI / 90) * 90
  return ((deg % 360) + 360) % 360
}

// Bytes of the codec configuration box (avcC/hvcC/vpcC/av1C) without its 8-byte header.
function codecDescription(entry) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
  if (!box) return undefined
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
  box.write(stream)
  return new Uint8Array(stream.buffer, 8)
}

function toSamples(trak) {
  return trak.samples.map((s, i) => ({
    i,
    offset: s.offset,
    size: s.size,
    cts: s.cts,
    sync: !!s.is_sync,
    us: Math.round((s.cts * 1e6) / s.timescale),
    durUs: Math.round((s.duration * 1e6) / s.timescale),
  }))
}

// Group consecutive samples (from index `from`) into one blob read of about SLICE bytes.
function rangeFor(samples, from) {
  const first = samples[from]
  let end = first.offset + first.size, j = from + 1
  while (j < samples.length) {
    const s = samples[j]
    if (s.offset < first.offset || s.offset + s.size - first.offset > SLICE) break
    end = Math.max(end, s.offset + s.size)
    j++
  }
  return { start: first.offset, end, count: j - from }
}

// Draw `frame` rotated clockwise by `rotation` onto `canvas`; returns a new VideoFrame.
function rotateFrame(frame, rotation, canvas) {
  const w = frame.displayWidth, h = frame.displayHeight
  const swap = rotation === 90 || rotation === 270
  const cw = swap ? h : w, ch = swap ? w : h
  if (canvas.width !== cw) canvas.width = cw
  if (canvas.height !== ch) canvas.height = ch
  const ctx = canvas.getContext('2d')
  // setTransform(a, b, c, d, e, f): x' = a*x + c*y + e, y' = b*x + d*y + f
  if (rotation === 90) ctx.setTransform(0, 1, -1, 0, cw, 0)
  else if (rotation === 180) ctx.setTransform(-1, 0, 0, -1, cw, ch)
  else ctx.setTransform(0, -1, 1, 0, 0, ch)
  ctx.drawImage(frame, 0, 0, w, h)
  const init = { timestamp: frame.timestamp }
  if (frame.duration != null) init.duration = frame.duration
  return new VideoFrame(canvas, init)
}

export class FileVideoSource {
  /**
   * @param {Blob} blob
   * @returns {Promise<FileVideoSource>}
   */
  static async open(blob) {
    const src = new FileVideoSource(blob, await parseHeader(blob))
    await assertDecodable(src._config)
    return src
  }

  constructor(blob, { file, info }) {
    this._blob = blob
    this._runs = new Set()

    const vt = info.videoTracks[0]
    const trak = file.getTrackById(vt.id)
    const entry = trak.mdia.minf.stbl.stsd.entries[0]
    this._decodeOrder = toSamples(trak)
    this._presOrder = [...this._decodeOrder].sort((a, b) => a.cts - b.cts)
    this._indexByUs = new Map(this._presOrder.map((s, idx) => [s.us, idx]))
    this._t0 = this._presOrder.length ? this._presOrder[0].us : 0

    const codedW = vt.video?.width || entry.width, codedH = vt.video?.height || entry.height
    this._config = { codec: vt.codec, codedWidth: codedW, codedHeight: codedH }
    const description = codecDescription(entry)
    if (description) this._config.description = description

    const rotation = rotationFromMatrix(vt.matrix)
    const swap = rotation === 90 || rotation === 270
    const frameCount = this._presOrder.length
    const ts = trak.mdia.mdhd.timescale
    let duration = 0
    if (frameCount) {
      let end = -Infinity
      for (const s of trak.samples) end = Math.max(end, s.cts + s.duration)
      duration = (end - this._presOrder[0].cts) / ts
    }
    this._rotation = rotation

    const at = (info.audioTracks || [])[0]
    this._audioTrack = at ? { info: at, trak: file.getTrackById(at.id) } : null

    this.meta = {
      width: swap ? codedH : codedW,
      height: swap ? codedW : codedH,
      fps: duration > 0 ? frameCount / duration : 0,
      duration,
      frameCount,
      rotation,
      codec: vt.codec,
      hasAudio: !!at,
      live: false,
    }
  }

  /**
   * Decoded frames in presentation order, upright.
   * @param {{ startFrame?: number }} [opts]
   * @returns {AsyncGenerator<{ image: VideoFrame, t: number, index: number }>}
   */
  async *frames({ startFrame = 0 } = {}) {
    const dec = this._decodeOrder, pres = this._presOrder, n = dec.length
    startFrame = Math.max(0, Math.floor(startFrame) || 0)
    if (startFrame >= n) return

    // Start at the last keyframe at or before the target frame (presentation order).
    const target = pres[startFrame]
    let next = 0
    for (let i = 0; i <= target.i; i++) if (dec[i].sync && dec[i].cts <= target.cts) next = i

    const run = { stopped: false, wake: null, queue: [], decoder: null }
    const notify = () => { const w = run.wake; run.wake = null; if (w) w() }
    run.notify = notify
    let error = null, flushing = false, flushed = false
    const decoder = new VideoDecoder({
      output: (f) => { if (run.stopped) f.close(); else { run.queue.push(f); notify() } },
      error: (e) => { error = e; notify() },
    })
    decoder.ondequeue = notify
    run.decoder = decoder
    this._runs.add(run)

    const canvas = this._rotation ? new OffscreenCanvas(1, 1) : null
    let cache = null, cacheStart = 0, lastIndex = startFrame - 1
    try {
      decoder.configure(this._config)
      while (!run.stopped) {
        if (error) throw namedError('VideoDecodeError', `Video decoding failed: ${error.message || error}`, error)

        if (run.queue.length) {
          const raw = run.queue.shift()
          let index = this._indexByUs.get(raw.timestamp)
          if (index === undefined) index = lastIndex + 1
          if (index < startFrame) { raw.close(); continue }
          lastIndex = index
          const t = (raw.timestamp - this._t0) / 1e6
          let image = raw
          if (canvas) { image = rotateFrame(raw, this._rotation, canvas); raw.close() }
          yield { image, t, index }
          continue
        }
        if (flushed) break

        if (next < n && decoder.decodeQueueSize <= MAX_DECODE_QUEUE) {
          const s = dec[next]
          if (!cache || s.offset < cacheStart || s.offset + s.size > cacheStart + cache.byteLength) {
            const r = rangeFor(dec, next)
            cache = await readRange(this._blob, r.start, r.end)
            cacheStart = r.start
            continue // re-check stop/error/queue after the await
          }
          while (next < n && decoder.decodeQueueSize <= MAX_DECODE_QUEUE) {
            const c = dec[next]
            if (c.offset < cacheStart || c.offset + c.size > cacheStart + cache.byteLength) break
            const at = c.offset - cacheStart
            decoder.decode(new EncodedVideoChunk({
              type: c.sync ? 'key' : 'delta',
              timestamp: c.us,
              duration: c.durUs,
              data: cache.subarray(at, at + c.size),
            }))
            next++
          }
          continue
        }

        if (next >= n && !flushing) {
          flushing = true
          decoder.flush().then(
            () => { flushed = true; notify() },
            (e) => { if (!run.stopped && !error) error = e; notify() },
          )
          continue
        }

        // Wait for a decoded frame, a dequeue, or the flush to finish.
        await new Promise((resolve) => { run.wake = resolve; setTimeout(resolve, 100) })
      }
    } finally {
      this._endRun(run)
    }
  }

  _endRun(run) {
    run.stopped = true
    for (const f of run.queue) f.close()
    run.queue.length = 0
    if (run.decoder && run.decoder.state !== 'closed') run.decoder.close()
    this._runs.delete(run)
    run.notify()
  }

  /**
   * All AAC samples of the first audio track, for passthrough muxing.
   * Timestamps are microseconds from the first audio sample.
   * Resolves null when there is no AAC audio track.
   */
  async readAudio() {
    const a = this._audioTrack
    if (!a || !String(a.info.codec).startsWith('mp4a')) return null
    const entry = a.trak.mdia.minf.stbl.stsd.entries[0]
    const dsi = entry.esds?.esd?.findDescriptor(4)?.findDescriptor(5)
    if (!dsi || !dsi.data) return null

    const samples = a.trak.samples.map((s) => ({ offset: s.offset, size: s.size, cts: s.cts, duration: s.duration, timescale: s.timescale }))
    let t0 = Infinity
    for (const s of samples) t0 = Math.min(t0, s.cts)
    const chunks = []
    for (let i = 0; i < samples.length;) {
      const r = rangeFor(samples, i)
      const buf = await readRange(this._blob, r.start, r.end)
      for (let k = 0; k < r.count; k++, i++) {
        const s = samples[i]
        chunks.push({
          data: buf.slice(s.offset - r.start, s.offset - r.start + s.size),
          timestamp: Math.round(((s.cts - t0) * 1e6) / s.timescale),
          duration: Math.round((s.duration * 1e6) / s.timescale),
        })
      }
    }
    return {
      codec: 'aac',
      sampleRate: a.info.audio?.sample_rate || entry.getSampleRate?.(),
      numberOfChannels: a.info.audio?.channel_count || entry.getChannelCount?.(),
      description: new Uint8Array(dsi.data),
      chunks,
    }
  }

  /** Ends any running generator, closes pending frames and the decoder. */
  stop() {
    for (const run of [...this._runs]) this._endRun(run)
  }
}

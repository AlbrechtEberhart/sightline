// LiveCameraSource: iPhone camera (or a looping debug file) as a FrameSource.
//
// Implements the FrameSource interface from shared/frame-source.js:
// `meta`, `frames()` and `stop()`. Newest-frame semantics: a VideoFrame is
// wrapped only when the consumer asks for the next one, so a slow detector
// loop never builds up a queue (and so never builds up lag). The consumer
// owns each yielded `image` and must close() it.

const REAR_RE = /back|rear|environment/i

/**
 * List the rear camera lenses. Before camera permission is granted browsers
 * return empty labels; in that case every videoinput is returned with a
 * generic "Camera N" label so the UI can still offer a choice.
 * @param {() => Promise<MediaDeviceInfo[]>} [enumerate]
 * @returns {Promise<Array<{ deviceId: string, label: string }>>}
 */
export async function listLenses(enumerate = () => navigator.mediaDevices.enumerateDevices()) {
  const videos = (await enumerate()).filter((d) => d.kind === 'videoinput')
  if (videos.length && videos.every((d) => !d.label)) {
    return videos.map((d, i) => ({ deviceId: d.deviceId, label: `Camera ${i + 1}` }))
  }
  return videos.filter((d) => REAR_RE.test(d.label)).map((d) => ({ deviceId: d.deviceId, label: d.label }))
}

function waitForMetadata(video) {
  if (video.readyState >= 1 && video.videoWidth) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(video.error || new Error('video failed to load')) }
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', done)
      video.removeEventListener('error', fail)
    }
    video.addEventListener('loadedmetadata', done)
    video.addEventListener('error', fail)
  })
}

export class LiveCameraSource {
  /**
   * @param {{ deviceId?: string, debugFile?: Blob }} [opts]
   * @returns {Promise<LiveCameraSource>}
   */
  static async open({ deviceId, debugFile } = {}) {
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.autoplay = true
    // Attributes too, so iOS Safari honours them.
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('autoplay', '')

    let stream = null
    let objectUrl = null
    let fps = 30
    try {
      if (debugFile) {
        video.loop = true
        objectUrl = URL.createObjectURL(debugFile)
        video.src = objectUrl
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              facingMode: deviceId ? undefined : 'environment',
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          })
        } catch (err) {
          if (err && err.name === 'NotAllowedError') {
            const e = new Error('Camera permission was denied', { cause: err })
            e.name = 'CameraPermissionError'
            throw e
          }
          throw err
        }
        const track = stream.getVideoTracks()[0]
        fps = (track && track.getSettings && track.getSettings().frameRate) || 30
        video.srcObject = stream
      }
      await waitForMetadata(video)
      await video.play()
    } catch (err) {
      if (stream) stream.getTracks().forEach((t) => t.stop())
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      video.removeAttribute('src')
      video.srcObject = null
      throw err
    }
    return new LiveCameraSource(video, stream, objectUrl, {
      width: video.videoWidth, height: video.videoHeight, fps, live: true,
    })
  }

  constructor(video, stream, objectUrl, meta) {
    this.video = video
    this.meta = meta
    this._stream = stream
    this._objectUrl = objectUrl
    this._t0 = performance.now()
    this._stopped = false
    this._wakers = new Set() // resolvers of pending frame waits, released by stop()
  }

  /** Resolves true when a new video frame is presented, false if stopped first. */
  _nextFrameReady() {
    if (this._stopped) return Promise.resolve(false)
    const video = this.video
    return new Promise((resolve) => {
      let handle = null
      let cancel = () => {}
      const finish = (ok) => {
        this._wakers.delete(wake)
        cancel()
        resolve(ok)
      }
      const wake = () => finish(false)
      this._wakers.add(wake)
      if (typeof video.requestVideoFrameCallback === 'function') {
        handle = video.requestVideoFrameCallback(() => finish(!this._stopped))
        cancel = () => { try { video.cancelVideoFrameCallback(handle) } catch { /* already fired */ } }
      } else {
        // Older Safari: rAF plus a currentTime-changed check.
        let lastTime = video.currentTime
        const tick = () => {
          if (this._stopped) return finish(false)
          if (video.currentTime !== lastTime && video.readyState >= 2) return finish(true)
          handle = requestAnimationFrame(tick)
        }
        handle = requestAnimationFrame(tick)
        cancel = () => cancelAnimationFrame(handle)
      }
    })
  }

  /** @returns {AsyncGenerator<{ image: VideoFrame, t: number, motion: undefined }>} */
  async *frames() {
    let lastT = -Infinity
    while (!this._stopped) {
      if (!(await this._nextFrameReady())) return
      let t = (performance.now() - this._t0) / 1000
      if (t <= lastT) t = lastT + 1e-6 // strictly increasing
      lastT = t
      const image = new VideoFrame(this.video, { timestamp: Math.round(t * 1e6) })
      yield { image, t, motion: undefined }
    }
  }

  stop() {
    if (this._stopped) return
    this._stopped = true
    for (const wake of [...this._wakers]) wake()
    if (this._stream) this._stream.getTracks().forEach((t) => t.stop())
    this.video.pause()
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl)
    this.video.removeAttribute('src')
    this.video.srcObject = null
    this.video.load()
    this._stream = null
    this._objectUrl = null
  }
}

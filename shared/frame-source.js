// Frame-source interface (spec 2.2). JSDoc typedefs only; no runtime code.
//
// Every tool reads frames through this one interface and does not know which
// app it runs in. LiveCameraSource (live/live-camera.js) and FileVideoSource
// (recorded/video-source.js) both implement it.
//
// Contract: the consumer owns every yielded `image` and must call
// `image.close()` on it (VideoFrame and ImageBitmap hold GPU/decoder memory).
// A source closes any frames it has not yet yielded when its generator ends,
// when the consumer breaks out of `for await`, or when `stop()` is called.

/**
 * @typedef {Object} Motion
 * @property {number} yaw
 * @property {number} pitch
 * @property {number} roll
 * @property {{ alpha: number, beta: number, gamma: number }} rotationRate
 */

/**
 * @typedef {Object} Frame
 * @property {VideoFrame | ImageBitmap} image  Upright image. The consumer calls close() on it.
 * @property {number} t        Seconds from the start of the source.
 * @property {number} [index]  Frame number in presentation order (file sources only).
 * @property {Motion} [motion] Latest device-motion reading (live sources only).
 */

/**
 * @typedef {Object} FrameSourceMeta
 * @property {number} width    Upright width in pixels.
 * @property {number} height   Upright height in pixels.
 * @property {number} fps
 * @property {number} [duration]  Seconds; absent for live sources.
 * @property {boolean} live
 */

/**
 * @typedef {Object} FrameSource
 * @property {FrameSourceMeta} meta
 * @property {(opts?: Object) => AsyncGenerator<Frame>} frames
 * @property {() => void} stop  Ends any running generator and releases resources.
 */

export {}

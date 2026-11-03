// Frame-rate meter and status text for the Live view. Pure functions, no DOM.

// Trailing-window frame-rate meter. Ticks must arrive in ascending time order.
// The window at time now is the half-open interval (now - windowSec, now].
// Rate: with at least 2 ticks in the window and an observed span shorter than the window
// (warm-up), it is (ticks - 1) / span, so two ticks 100 ms apart read 10 fps.
// Otherwise it is ticks / windowSec.
export function createFpsMeter(windowSec = 1) {
  const windowMs = windowSec * 1000
  let stamps = []

  function inWindow(nowMs) {
    return stamps.filter((t) => t > nowMs - windowMs && t <= nowMs)
  }

  function rate(list) {
    const n = list.length
    if (n >= 2) {
      const spanMs = list[n - 1] - list[0]
      if (spanMs > 0 && spanMs < windowMs) return (n - 1) / (spanMs / 1000)
    }
    return n / windowSec
  }

  return {
    tick(nowMs) {
      stamps.push(nowMs)
      const cutoff = nowMs - windowMs
      let i = 0
      while (i < stamps.length && stamps[i] <= cutoff) i++
      if (i > 0) stamps = stamps.slice(i)
    },
    // Frame rate as of nowMs. Decays toward 0 when ticks stop.
    fpsAt(nowMs) {
      return rate(inWindow(nowMs))
    },
    // Frame rate as of the most recent tick. Kept for compatibility with callers that have no clock.
    get fps() {
      return stamps.length ? rate(inWindow(stamps[stamps.length - 1])) : 0
    },
  }
}

const BACKEND_LABEL = { webgpu: 'WebGPU', wasm: 'WASM' }

// e.g. '5 objects · WebGPU · 11 fps' or '1 object · WASM · 3 fps'.
export function formatStatus({ count, backend, fps }) {
  const objects = count === 1 ? 'object' : 'objects'
  const engine = BACKEND_LABEL[backend] ?? String(backend)
  return `${count} ${objects} · ${engine} · ${Math.round(fps)} fps`
}

// Returns a hint below 3 fps, otherwise null. Recording-specific advice when recording.
export function lowFpsHint(fps, recording) {
  if (fps < 3) {
    return recording
      ? 'Low frame rate. Stop recording to speed up.'
      : 'Low frame rate. Try the Ultra Wide lens or input size 320.'
  }
  return null
}

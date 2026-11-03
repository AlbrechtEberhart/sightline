// Frame-rate meter and status text for the Live view. Pure functions, no DOM.

// Counts ticks in a trailing window. fps = ticks in (last tick - window, last tick] / window length.
// The window is anchored on the most recent tick, so fps does not decay while ticks stop.
export function createFpsMeter(windowSec = 1) {
  const windowMs = windowSec * 1000
  let stamps = []
  return {
    tick(nowMs) {
      stamps.push(nowMs)
      const cutoff = nowMs - windowMs
      let i = 0
      while (i < stamps.length && stamps[i] <= cutoff) i++
      if (i > 0) stamps = stamps.slice(i)
    },
    get fps() {
      return stamps.length / windowSec
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

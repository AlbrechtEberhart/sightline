// Motion: iPhone gyroscope reader for the Live panorama page.
//
// Turns DeviceOrientation (alpha/beta/gamma) into the rear camera's view
// direction (yaw, pitch, roll) and DeviceMotion into a turn rate, with the iOS
// permission prompt handled. Earth frame per the W3C spec: x east, y north,
// z up. Device frame: x right, y up the screen, z out of the screen; the rear
// camera looks along device -z.

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** Wrap an angle in degrees into (-180, 180]. */
function wrap(deg) {
  let d = deg % 360
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d
}

/**
 * Absolute camera orientation from DeviceOrientation angles.
 * yaw: heading, positive when turning right; pitch: positive looking up;
 * roll: positive when the top of the image tilts to the right.
 * @param {number} alpha degrees
 * @param {number} beta degrees
 * @param {number} gamma degrees
 * @param {number} [screenAngle] screen.orientation.angle in degrees
 * @returns {{ yaw: number, pitch: number, roll: number }}
 */
export function orientationToCamera(alpha, beta, gamma, screenAngle = 0) {
  const ca = Math.cos(alpha * RAD), sa = Math.sin(alpha * RAD)
  const cb = Math.cos(beta * RAD), sb = Math.sin(beta * RAD)
  const cg = Math.cos(gamma * RAD), sg = Math.sin(gamma * RAD)
  // R = Rz(alpha) * Rx(beta) * Ry(gamma); apply it to a device-frame vector.
  const rot = ([x, y, z]) => {
    const x1 = cg * x + sg * z, y1 = y, z1 = -sg * x + cg * z // Ry(gamma)
    const x2 = x1, y2 = cb * y1 - sb * z1, z2 = sb * y1 + cb * z1 // Rx(beta)
    return [ca * x2 - sa * y2, sa * x2 + ca * y2, z2] // Rz(alpha)
  }
  const f = rot([0, 0, -1])
  const sc = Math.cos(screenAngle * RAD), ss = Math.sin(screenAngle * RAD)
  const u = rot([ss, sc, 0]) // screen "up" in the Earth frame

  const pitch = Math.asin(Math.max(-1, Math.min(1, f[2]))) * DEG
  const yaw = Math.atan2(f[0], f[1]) * DEG

  // Level up: world up with its component along f removed. Right = f x level.
  const lx = -f[2] * f[0], ly = -f[2] * f[1], lz = 1 - f[2] * f[2]
  const ln = Math.hypot(lx, ly, lz)
  let roll = 0
  if (ln > 1e-9) {
    const l = [lx / ln, ly / ln, lz / ln]
    const r = [f[1] * l[2] - f[2] * l[1], f[2] * l[0] - f[0] * l[2], f[0] * l[1] - f[1] * l[0]]
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    roll = Math.atan2(dot(u, r), dot(u, l)) * DEG
  }
  return { yaw, pitch, roll }
}

/**
 * @param {EventTarget} [win] where the sensor events are dispatched
 * @returns {{
 *   requestPermission: () => Promise<'granted' | 'denied'>,
 *   start: () => void, stop: () => void, zero: () => void,
 *   reading: () => ({ yaw: number, pitch: number, roll: number, rate: number } | null),
 * }}
 */
export function createMotion(win = window) {
  let abs = null // latest absolute { yaw, pitch, roll }
  let origin = { yaw: 0, pitch: 0, roll: 0 }
  let rate = 0

  const screenAngle = () => win.screen?.orientation?.angle ?? 0

  const onOrientation = (e) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) { abs = null; return }
    abs = orientationToCamera(e.alpha, e.beta, e.gamma, screenAngle())
  }
  const onMotion = (e) => {
    const r = e.rotationRate
    rate = r ? Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) : 0
  }

  return {
    async requestPermission() {
      try {
        const asks = [win.DeviceOrientationEvent, win.DeviceMotionEvent]
          .filter((E) => typeof E?.requestPermission === 'function')
          .map((E) => E.requestPermission())
        const results = await Promise.all(asks)
        return results.every((r) => r === 'granted') ? 'granted' : 'denied'
      } catch {
        return 'denied'
      }
    },
    start() {
      win.addEventListener('deviceorientation', onOrientation)
      win.addEventListener('devicemotion', onMotion)
    },
    stop() {
      win.removeEventListener('deviceorientation', onOrientation)
      win.removeEventListener('devicemotion', onMotion)
    },
    /** Make the current direction the origin of reading(). */
    zero() {
      if (abs) origin = { ...abs }
    },
    reading() {
      if (!abs) return null
      return {
        yaw: wrap(abs.yaw - origin.yaw),
        pitch: abs.pitch - origin.pitch,
        roll: abs.roll - origin.roll,
        rate,
      }
    },
  }
}

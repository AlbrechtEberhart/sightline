// Live capture rules: decides when to take each panorama photo and which warning to show. Pure state machine, no DOM.
//
// Feed it one reading per sensor/frame tick: angles in degrees relative to Start, rate in deg/s, and the current
// frame sharpness. A photo is taken when the phone is steady, level and sharp and the sweep has moved far enough
// since the last photo; the sweep direction is fixed by the first real movement and never changes.
// Yaw may arrive wrapped to (-180, 180] (as live/motion.js reports it); it is unwrapped here, so every rule and
// photosYaw use the continuous turn since the first reading and a sweep can pass 180 degrees.

const LEVEL_DEG = 8 // |pitch| and |roll| at or below this count as level
const STEADY_RATE = 30 // deg/s; strictly below this is steady enough to shoot
const SLOW_DOWN_RATE = 40 // deg/s; strictly above this shows 'Slow down'
const DIRECTION_YAW = 5 // |yaw| beyond this sets the sweep direction
const STEP_FRACTION = 0.65 // next photo is due after this fraction of the horizontal field of view
const TOO_FAR_FRACTION = 0.9 // beyond this fraction without a shot, ask the user to go back
const SHARP_WINDOW = 15 // number of recent sharpness values in the median
const SHARP_RATIO = 0.8 // a frame is sharp at this fraction of the recent median or better
const WORKER_SWEEP_DEG = 340 // stitch-worker.js drops photos past this sweep (its MAX_SWEEP_DEG)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function wrap180(deg) {
  const d = ((deg % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

// maxSweepDeg: a photo is taken only while |yaw - first photo's yaw| + hfovDeg <= maxSweepDeg. The default stays
// 5 degrees under the worker's cap, so gyro-versus-matched yaw differences do not make the worker drop the last photo.
export function createCaptureRules({ hfovDeg, maxPhotos = 12, maxSweepDeg = WORKER_SWEEP_DEG - 5 }) {
  const recent = []
  const shots = [] // unwrapped yaw of each photo
  let direction = 0
  let done = false
  let unwrapped = 0 // continuous yaw: the first reading is the base, then each wrapped step is added
  let lastRaw = null

  const fits = (yaw) => Math.abs(yaw - shots[0]) + hfovDeg <= maxSweepDeg

  function update({ yaw, pitch, roll, rate, sharpness }) {
    if (done) return { shoot: false, warning: null, direction, count: shots.length, done: true }

    if (Number.isFinite(yaw)) {
      unwrapped = lastRaw === null ? yaw : unwrapped + wrap180(yaw - lastRaw)
      lastRaw = yaw
    }
    recent.push(sharpness)
    if (recent.length > SHARP_WINDOW) recent.shift()
    if (direction === 0 && Math.abs(unwrapped) > DIRECTION_YAW) direction = unwrapped > 0 ? 1 : -1

    const steady = rate < STEADY_RATE
    const level = Math.abs(pitch) <= LEVEL_DEG && Math.abs(roll) <= LEVEL_DEG
    const sharp = sharpness >= SHARP_RATIO * median(recent)

    const step = STEP_FRACTION * hfovDeg
    const travelled = shots.length && direction ? direction * (unwrapped - shots[shots.length - 1]) : 0
    const due = shots.length === 0 || (direction !== 0 && travelled >= step)

    if (due && shots.length && !fits(unwrapped)) { // this shot would pass the sweep cap: end capture without it
      done = true
      return { shoot: false, warning: null, direction, count: shots.length, done }
    }
    if (due && steady && level && sharp) {
      shots.push(unwrapped)
      // Done at the photo cap, or when even the nearest next shot (one step on) would pass the sweep cap.
      done = shots.length >= maxPhotos || (direction !== 0 && !fits(unwrapped + direction * step))
      return { shoot: true, warning: null, direction, count: shots.length, done }
    }

    let warning = null
    if (rate > SLOW_DOWN_RATE) warning = 'Slow down'
    else if (!level) warning = 'Keep level'
    else if (travelled > TOO_FAR_FRACTION * hfovDeg) warning = 'Go back a little'
    return { shoot: false, warning, direction, count: shots.length, done: false }
  }

  return {
    update,
    get photosYaw() { return [...shots] },
  }
}

// Photo cap for Live so the sweep ends before the stitch worker's 340 degree limit would drop photos.
export function maxPhotosFor(hfovDeg) {
  return Math.min(12, 1 + Math.floor((WORKER_SWEEP_DEG - hfovDeg) / (STEP_FRACTION * hfovDeg)))
}

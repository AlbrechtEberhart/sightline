// Live capture rules: decides when to take each panorama photo and which warning to show. Pure state machine, no DOM.
//
// Feed it one reading per sensor/frame tick: angles in degrees relative to Start, rate in deg/s, and the current
// frame sharpness. A photo is taken when the phone is steady, level and sharp and the sweep has moved far enough
// since the last photo; the sweep direction is fixed by the first real movement and never changes.

const LEVEL_DEG = 8 // |pitch| and |roll| at or below this count as level
const STEADY_RATE = 30 // deg/s; strictly below this is steady enough to shoot
const SLOW_DOWN_RATE = 40 // deg/s; strictly above this shows 'Slow down'
const DIRECTION_YAW = 5 // |yaw| beyond this sets the sweep direction
const STEP_FRACTION = 0.65 // next photo is due after this fraction of the horizontal field of view
const TOO_FAR_FRACTION = 0.9 // beyond this fraction without a shot, ask the user to go back
const SHARP_WINDOW = 15 // number of recent sharpness values in the median
const SHARP_RATIO = 0.8 // a frame is sharp at this fraction of the recent median or better

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function createCaptureRules({ hfovDeg, maxPhotos = 12 }) {
  const recent = []
  const shots = []
  let direction = 0
  let done = false

  function update({ yaw, pitch, roll, rate, sharpness }) {
    if (done) return { shoot: false, warning: null, direction, count: shots.length, done: true }

    recent.push(sharpness)
    if (recent.length > SHARP_WINDOW) recent.shift()
    if (direction === 0 && Math.abs(yaw) > DIRECTION_YAW) direction = yaw > 0 ? 1 : -1

    const steady = rate < STEADY_RATE
    const level = Math.abs(pitch) <= LEVEL_DEG && Math.abs(roll) <= LEVEL_DEG
    const sharp = sharpness >= SHARP_RATIO * median(recent)

    const travelled = shots.length && direction ? direction * (yaw - shots[shots.length - 1]) : 0
    const due = shots.length === 0 || (direction !== 0 && travelled >= STEP_FRACTION * hfovDeg)

    if (due && steady && level && sharp) {
      shots.push(yaw)
      done = shots.length >= maxPhotos
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
  return Math.min(12, 1 + Math.floor((340 - hfovDeg) / (STEP_FRACTION * hfovDeg)))
}

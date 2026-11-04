// Studio frame picker: a streaming state machine that decides which decoded video frames become panorama photos
// and tells the caller which full-resolution frames to keep in memory. Pure JS, no DOM.
//
// Feed it one frame at a time (its horizontal shift from the previous frame and its sharpness). The shifts add up
// to a position along the pan; the direction is fixed the first time that passes DIRECTION_FRACTION of the width.
// Photos are due every STEP_FRACTION of the width. In the window around each due position the sharpest frame is
// kept, and it becomes a final pick when the pan moves past the window. Only that best frame, plus the sharpest
// frame since the last window (for the end-of-clip rule), is ever held.

const STEP_FRACTION = 0.65 // spacing between target positions, in frame widths
const WINDOW_FRACTION = 0.1 // half-width of each target window
const DIRECTION_FRACTION = 0.1 // |position| beyond this fixes the pan direction
const END_FRACTION = 0.3 // movement after the last pick needed to add a closing photo
const MIN_PAN_FRACTION = 0.5 // total movement below this is "Not enough panning"
const FAST_FRACTION = 0.15 // any single |dx| above this is "Pan was fast"

export function createFramePicker({ width, maxPhotos = 12 }) {
  const held = new Set()
  let pos = 0
  let direction = 0 // +1 / -1 once set
  let maxS = 0 // furthest progress along the pan
  let lastS = 0
  let fast = false
  let win = 0 // index of the window being waited for or filled
  let entered = false // a frame has been inside the current window
  let best = null // sharpest frame in the current window
  let tail = null // sharpest frame since the last window closed, outside any window
  let lastPickS = null
  let count = 0

  const target = k => k * STEP_FRACTION * width
  const upper = k => target(k) + WINDOW_FRACTION * width
  const lower = k => k === 0 ? -Infinity : target(k) - WINDOW_FRACTION * width

  function drop(frame, release) {
    held.delete(frame.index)
    release.push(frame.index)
  }

  function push({ index, dx, sharpness }) {
    pos += dx
    if (Math.abs(dx) > FAST_FRACTION * width) fast = true
    if (!direction && Math.abs(pos) > DIRECTION_FRACTION * width) direction = pos > 0 ? 1 : -1
    const s = direction ? direction * pos : Math.abs(pos)
    maxS = Math.max(maxS, s)
    lastS = s

    const release = []
    if (count >= maxPhotos) return { hold: false, release, pick: null }

    let pick = null
    let hold = false
    let consumed = false // this frame is itself the pick

    // Close every window the pan has moved past; at most one pick per push.
    while (s > upper(win)) {
      if (tail) { drop(tail, release); tail = null }
      if (pick === null) {
        if (best) {
          pick = best.index
          lastPickS = best.s
          held.delete(best.index)
        } else {
          pick = index
          lastPickS = s
          hold = true
          consumed = true
        }
        count++
      }
      best = null
      entered = false
      win++
    }

    if (count >= maxPhotos) {
      for (const i of held) release.push(i)
      held.clear()
      best = null
      tail = null
      return { hold, release, pick }
    }

    if (!consumed) {
      const frame = { index, s, sharpness }
      if (s >= lower(win)) {
        if (tail) { drop(tail, release); tail = null }
        entered = true
        if (!best || sharpness > best.sharpness) {
          if (best) drop(best, release)
          best = frame
          held.add(index)
          hold = true
        }
      } else if (win > 0 && !entered && (!tail || sharpness > tail.sharpness)) {
        if (tail) drop(tail, release)
        tail = frame
        held.add(index)
        hold = true
      }
    }
    return { hold, release, pick }
  }

  function finish() {
    const messages = []
    if (fast) messages.push('Pan was fast')
    if (count >= maxPhotos) messages.push(`Used the first ${maxPhotos} frames of the pan`)

    let picks = []
    let error = null
    if (maxS < MIN_PAN_FRACTION * width) {
      error = 'Not enough panning'
    } else if (count < maxPhotos) {
      let last = null
      if (entered && best) last = best
      else if (tail && (lastPickS === null || lastS - lastPickS >= END_FRACTION * width)) last = tail
      if (last) {
        picks = [last.index]
        held.delete(last.index)
      }
    }
    const release = [...held]
    held.clear()
    best = null
    tail = null
    return { picks, release, messages, error }
  }

  return { push, finish }
}

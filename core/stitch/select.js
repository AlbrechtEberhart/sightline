// Studio frame picker: a streaming state machine that decides which decoded video frames become panorama photos
// and tells the caller which full-resolution frames to keep in memory. Pure JS, no DOM.
//
// Feed it one frame at a time (its horizontal shift from the previous frame and its sharpness). The shifts add up
// to a position along the pan; the direction is fixed the first time that passes DIRECTION_FRACTION of the width.
// The first window covers the start of the pan. Each later window is relative to the previous pick at position p:
// [p + STEP_MIN, p + STEP_MAX] of the width. The sharpest frame in the window is kept, and it becomes a final pick
// when the pan moves past the window, so consecutive picks are STEP_MIN..STEP_MAX apart (35-50% overlap) unless the pan jumps over a window
// (a frame that is already past the new window becomes its pending best and is picked next).
// Only that best frame, plus the sharpest frame since the last window (for the end-of-clip rule), is ever held.
//
// Caller notes:
//  - A single push can return hold: true together with pick for the same index (a window the pan jumped over takes
//    the first frame past it). Hold that frame, then hand it straight to the stitcher; it is not held afterwards.
//  - Picks returned from push() before finish() reports error "Not enough panning" must be discarded by the caller.
//  - A non-finite dx counts as a frame but adds no movement. width must be a finite number > 0 (else RangeError).

const FIRST_WINDOW = 0.1 // the first photo is the sharpest frame in the first 0.1 W of the pan
const STEP_MIN = 0.5 // each later window starts this far (in frame widths) past the previous pick
const STEP_MAX = 0.65 // ... and closes this far past it
const DIRECTION_FRACTION = 0.1 // |position| beyond this fixes the pan direction
const END_FRACTION = 0.3 // movement after the last pick needed to add a closing photo
const MIN_PAN_FRACTION = 0.5 // total movement below this is "Not enough panning"
const FAST_FRACTION = 0.15 // any single |dx| above this is "Pan was fast"

export function createFramePicker({ width, maxPhotos = 12 }) {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('createFramePicker: width must be a finite number > 0')
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

  const upper = () => win === 0 ? FIRST_WINDOW * width : lastPickS + STEP_MAX * width
  const lower = () => win === 0 ? -Infinity : lastPickS + STEP_MIN * width

  function drop(frame, release) {
    held.delete(frame.index)
    release.push(frame.index)
  }

  function push({ index, dx, sharpness }) {
    if (!Number.isFinite(dx)) dx = 0
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

    // Close the window if the pan has moved past it; at most one pick per push.
    if (s > upper()) {
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
      // Defensive: closing a window already gave up the tail and handed over the best, so nothing should be held here.
      for (const i of held) release.push(i)
      held.clear()
      best = null
      tail = null
      return { hold, release, pick }
    }

    if (!consumed) {
      const frame = { index, s, sharpness }
      if (s > upper()) {
        // Already past the new window (a jump): it is the pending best, and the next close or finish() picks it.
        entered = true
        best = frame
        held.add(index)
        hold = true
      } else if (s >= lower()) {
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

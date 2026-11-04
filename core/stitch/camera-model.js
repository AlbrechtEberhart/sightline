// Phone camera model for the panorama stitcher. Pure maths, no DOM.
// Lens fields of view are the horizontal angle across the LONG side of the sensor at 1x zoom.

export const LENS_HFOV = { wide: 67, ultrawide: 106 }

function lensHfov(lens) {
  const hfov = LENS_HFOV[lens]
  if (!(hfov > 0)) throw new Error(`unknown lens: ${lens}`)
  return hfov
}

// Focal length in pixels for a frame of width x height, from the long side. Zoom scales it linearly.
export function focalPx({ lens, width, height, zoom = 1 }) {
  const half = Math.max(width, height) / 2
  return zoom * half / Math.tan(lensHfov(lens) * Math.PI / 360)
}

// Field of view in degrees along `width` as displayed. A landscape frame (width >= height) shows the long
// side across; an upright frame shows the short side, whose half-extent is (short/long) times the long one.
// Zoom narrows the view through the tangent, not linearly.
export function displayedHfov({ lens, width, height, zoom = 1 }) {
  const ratio = width >= height ? 1 : width / height
  const halfTan = Math.tan(lensHfov(lens) * Math.PI / 360)
  return 2 * Math.atan(ratio * halfTan / zoom) * 180 / Math.PI
}

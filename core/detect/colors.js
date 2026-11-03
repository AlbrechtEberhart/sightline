// Fixed per-class box colours. Pure data and functions, no DOM, no I/O.
// Twenty entries, indexed by classId % 20. Chosen to read well on the #0b1220 background.

const PALETTE = Object.freeze([
  '#ff4d4d', // red
  '#ff8a3d', // orange
  '#ffb627', // amber
  '#ffe14d', // yellow
  '#b8f23a', // lime
  '#5fe05a', // green
  '#2fe0a0', // mint
  '#2dd4d4', // teal
  '#2bb8ff', // sky
  '#4f7dff', // blue
  '#7b61ff', // indigo
  '#b15cff', // violet
  '#e05cff', // purple
  '#ff5cf0', // magenta
  '#ff5cae', // pink
  '#ff5c83', // rose
  '#c9d1e0', // silver
  '#d2a679', // tan
  '#f5f5f5', // white
  '#8b949e', // grey
])

export function colorFor(classId) {
  return PALETTE[classId % PALETTE.length]
}

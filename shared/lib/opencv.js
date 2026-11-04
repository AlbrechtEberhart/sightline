// OpenCV.js 4.10 (@techstark build, UMD), vendored. See ../vendor/VERSIONS.md.
// Call inside a worker only: the build is ~10 MB and its init blocks the thread.
// Module workers cannot importScripts, so the bytes (validated by fetchAsset on the page) are evaluated with indirect eval.

// Resolves the ready cv runtime from the posted file bytes.
export async function loadOpenCV(bytes) {
  const text = new TextDecoder().decode(bytes)
  ;(0, eval)(text) // indirect eval runs in global scope: the UMD wrapper sets self.cv
  const cv = self.cv
  if (!cv) throw new Error('OpenCV.js did not define cv')
  if (!cv.Mat) {
    await new Promise((resolve) => {
      // cv is a thenable that resolves to itself, so `await cv` would never settle. Resolve with no value instead.
      if (typeof cv.then === 'function') cv.then(() => resolve())
      else cv.onRuntimeInitialized = resolve
    })
  }
  // Same reason: returning a thenable from an async function would make the caller's await loop forever.
  delete cv.then
  return cv
}

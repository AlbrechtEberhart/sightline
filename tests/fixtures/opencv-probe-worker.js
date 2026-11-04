// Module worker for opencv.test.js: loads OpenCV.js from posted bytes and reports which APIs Panorama needs.
import { loadOpenCV } from '../../shared/lib/opencv.js'

self.onmessage = async (e) => {
  try {
    const cv = await loadOpenCV(new Uint8Array(e.data))
    self.postMessage({
      orb: typeof cv.ORB,
      homography: typeof cv.findHomography,
      remap: typeof cv.remap,
      bf: typeof cv.BFMatcher,
    })
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) })
  }
}

// Download (or fetch from cache) the YOLO model for an input size and create the detector.
// Callers keep their own progress UI and stale-run checks.
import { createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from './models.js'

export async function createDetectorFor(inputSize, onProgress) {
  const modelBytes = await fetchModel(MODEL_URLS[inputSize], onProgress)
  return createDetector({ modelBytes, inputSize, backend: 'auto' })
}

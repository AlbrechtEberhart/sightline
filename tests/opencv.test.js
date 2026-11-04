import { test, assertEqual } from './harness.js'
import { fetchAsset, OPENCV_ASSET } from '../shared/models.js'

test('opencv: loads in a module worker with ORB and findHomography', async () => {
  const bytes = await fetchAsset(OPENCV_ASSET.url, OPENCV_ASSET)
  const worker = new Worker(new URL('./fixtures/opencv-probe-worker.js', import.meta.url), { type: 'module' })
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('opencv probe timed out after 60 s')), 60000)
      worker.onmessage = (e) => { clearTimeout(timer); resolve(e.data) }
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(`opencv probe worker error: ${e.message}`)) }
      worker.postMessage(bytes.buffer, [bytes.buffer])
    })
    if (reply.error) throw new Error(`opencv probe failed: ${reply.error}`)
    assertEqual(reply, { orb: 'function', homography: 'function', remap: 'function', bf: 'function' })
  } finally {
    worker.terminate()
  }
})

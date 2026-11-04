import { test, assert, assertEqual, assertClose } from './harness.js'
import { fetchAsset, OPENCV_ASSET } from '../shared/models.js'
import { focalPx, displayedHfov } from '../core/stitch/camera-model.js'
import { createCaptureRules, maxPhotosFor } from '../core/stitch/capture.js'
import { toThumb } from '../core/stitch/thumb.js'
import { sharpness } from '../core/stitch/sharpness.js'
import { Stitcher } from '../core/stitch/stitcher.js'
import { makeScene, renderView } from './fixtures/synthetic-pan.js'

test('live-panorama: maxPhotosFor keeps Live inside the worker 340 degree cap', () => {
  assertEqual([67, 2 * Math.atan(360 / 640 * Math.tan(67 * Math.PI / 360)) * 180 / Math.PI].map(h => maxPhotosFor(h)), [7, 12])
})

test('live-panorama: capture rules plus stitcher on a scripted sweep', async () => {
  const W = 640, H = 360
  const f = focalPx({ lens: 'wide', width: W, height: H })
  const scene = makeScene({ f })
  const rules = createCaptureRules({ hfovDeg: displayedHfov({ lens: 'wide', width: W, height: H }) })
  const opencvBytes = await fetchAsset(OPENCV_ASSET.url, OPENCV_ASSET)
  const stitcher = await Stitcher.create({ opencvBytes, focalPx: f, width: W, height: H, mode: 'live' })
  const shots = []
  try {
    for (let yaw = 0; yaw <= 130; yaw += 2) {
      const view = renderView(scene, { yawDeg: yaw, pitchDeg: 0, width: W, height: H })
      const r = rules.update({ yaw, pitch: 0, roll: 0, rate: 20, sharpness: sharpness(toThumb(view)) })
      if (r.shoot) {
        shots.push(yaw)
        stitcher.add(await createImageBitmap(view), { yawHint: yaw })
      }
    }
    assertEqual(shots, [0, 44, 88])
    const result = await stitcher.finish()
    assertEqual(result.used, 3)
    result.yaws.forEach((y, i) => assertClose(y, [0, 44, 88][i], 0.3))
  } catch (err) {
    stitcher.cancel()
    throw err
  }
})

test('live-panorama: page loads with the tool switch', async () => {
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../live/panorama/?source=file&clip=../../tests/fixtures/bus-3s.mp4', import.meta.url); document.body.append(f)
  try {
    let state
    for (let i = 0; i < 120 && state !== 'ready'; i++) { await new Promise(r => setTimeout(r, 500)); state = f.contentWindow.__pano?.state }
    assertEqual(state, 'ready')
    const doc = f.contentDocument
    assert(doc.getElementById('start'), 'Start button')
    const links = doc.querySelectorAll('.tool-switch a')
    assertEqual(links.length, 2)
    assertEqual(doc.querySelector('.tool-switch a[aria-current="page"]').getAttribute('href'), '../panorama/')
    assert(doc.querySelector('.tool-switch a[href="../yolo/"]'), 'YOLO link')
  } finally { f.remove() }
})

test('live-panorama: Done before any photo shows Not enough turning and returns to ready', async () => {
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../live/panorama/?source=file&clip=../../tests/fixtures/bus-3s.mp4', import.meta.url); document.body.append(f)
  const until = async (fn) => { for (let i = 0; i < 160; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 500)) } return false }
  try {
    assert(await until(() => f.contentWindow.__pano?.state === 'ready'), 'ready')
    const doc = f.contentDocument
    // Some desktop browsers (the test pane included) expose requestPermission and answer 'denied': pin it to 'granted'.
    for (const E of [f.contentWindow.DeviceOrientationEvent, f.contentWindow.DeviceMotionEvent]) if (E) E.requestPermission = async () => 'granted'
    doc.getElementById('start').click()
    assert(await until(() => f.contentWindow.__pano.state === 'capturing'), 'capturing')
    doc.getElementById('done').click()
    assert(await until(() => /Not enough turning/.test(doc.getElementById('errors').innerText)), 'Not enough turning card')
    assertEqual(f.contentWindow.__pano.state, 'ready')
  } finally { f.remove() }
})

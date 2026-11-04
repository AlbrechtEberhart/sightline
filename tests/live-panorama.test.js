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
        stitcher.add(await createImageBitmap(view), { yawHint: rules.photosYaw.at(-1) }) // unwrapped, as Live passes it
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

// Opens the Live panorama page on the debug clip, waits for ready and pins the motion permission to 'granted'.
async function openLivePage() {
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../live/panorama/?source=file&clip=../../tests/fixtures/bus-3s.mp4', import.meta.url); document.body.append(f)
  const until = async (fn, tries = 160) => { for (let i = 0; i < tries; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 250)) } return false }
  if (!await until(() => f.contentWindow.__pano?.state === 'ready')) { f.remove(); throw new Error('page not ready') }
  for (const E of [f.contentWindow.DeviceOrientationEvent, f.contentWindow.DeviceMotionEvent]) if (E) E.requestPermission = async () => 'granted'
  const turnTo = (alpha) => f.contentWindow.dispatchEvent(Object.assign(new f.contentWindow.Event('deviceorientation'), { alpha, beta: 90, gamma: 0 }))
  return { f, doc: f.contentDocument, until, turnTo }
}

test('live-panorama: turning while Starting does not set the direction; the guide arrow shows it once set', async () => {
  const { f, doc, until, turnTo } = await openLivePage()
  let hold = null
  try {
    const guide = doc.getElementById('guide'), status = doc.getElementById('status')
    // Turn 40 degrees left as soon as capture state is entered: the observer runs as a microtask, before the
    // stitcher (a worker plus OpenCV start-up) can have settled, so this is always during "Starting…". The pose is
    // then held with an event every 50 ms, as a phone's sensor streams them (desktop Chrome also sends one null
    // reading when the listener is added).
    const app = doc.querySelector('.app')
    const turnedWhileStarting = new Promise((resolve) => {
      const mo = new f.contentWindow.MutationObserver(() => {
        if (app.dataset.state !== 'capturing') return
        mo.disconnect()
        const during = status.textContent
        turnTo(0)
        turnTo(40)
        hold = setInterval(() => turnTo(40), 50)
        resolve(during)
      })
      mo.observe(app, { attributes: true, attributeFilter: ['data-state'] })
    })
    doc.getElementById('start').click()
    assertEqual(await turnedWhileStarting, 'Starting…')
    assert(guide.hidden, 'guide hidden while Starting')
    assert(await until(() => status.textContent !== 'Starting…'), 'capture loop started')
    await new Promise(r => setTimeout(r, 1000))
    clearInterval(hold)
    assert(guide.hidden, 'the turn made during Starting did not set a direction')
    turnTo(30) // 10 degrees right of where capture started
    assert(await until(() => !guide.hidden), 'guide shown once the direction is set')
    assertEqual(guide.dataset.direction, 'right')
    // The guide sits under the bars and cards: it is below them in z-order and clear of the readout and controls.
    const z = (sel) => Number(f.contentWindow.getComputedStyle(doc.querySelector(sel)).zIndex)
    assert(z('#guide') < Math.min(z('.topbar'), z('.readout'), z('.controls'), z('.footer-disclaimer'), z('.overlay')), 'guide z-order')
    const g = doc.querySelector('.guide-arrow').getBoundingClientRect() // the tallest part; the line is at its middle
    for (const sel of ['.topbar', '.readout', '.controls', '.footer-disclaimer', '#strip']) {
      const r = doc.querySelector(sel).getBoundingClientRect()
      assert(g.bottom <= r.top || g.top >= r.bottom, `guide clear of ${sel}`)
    }
    doc.getElementById('cancel').click()
    assert(await until(() => f.contentWindow.__pano.state === 'ready'), 'ready after cancel')
    assert(guide.hidden, 'guide hidden outside capture')
  } finally { clearInterval(hold); f.remove() }
})

test('live-panorama: no motion reading after 3 s shows Waiting for the motion sensor', async () => {
  const { f, doc, until, turnTo } = await openLivePage()
  try {
    const status = doc.getElementById('status')
    doc.getElementById('start').click()
    assert(await until(() => status.textContent === 'Turn slowly'), 'capture loop started')
    await new Promise(r => setTimeout(r, 2000))
    assertEqual(status.textContent, 'Turn slowly')
    assert(await until(() => status.textContent === 'Waiting for the motion sensor…', 20), 'waiting status')
    turnTo(0)
    assert(await until(() => status.textContent !== 'Waiting for the motion sensor…'), 'status clears when readings arrive')
    doc.getElementById('cancel').click()
    assert(await until(() => f.contentWindow.__pano.state === 'ready'), 'ready after cancel')
  } finally { f.remove() }
})

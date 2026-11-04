// Sightline Live Panorama: tap Start, turn slowly; photos are taken automatically from the gyroscope,
// stitched in a worker, and the JPEG is offered through Share… / Save file.
import '../../shared/register-sw.js'
import { LiveCameraSource, zoomRange, setZoom } from '../live-camera.js'
import { createMotion } from '../motion.js'
import { createCaptureRules, maxPhotosFor } from '../../core/stitch/capture.js'
import { toThumb } from '../../core/stitch/thumb.js'
import { sharpness } from '../../core/stitch/sharpness.js'
import { focalPx, displayedHfov } from '../../core/stitch/camera-model.js'
import { Stitcher, photoSize, photoBitmap } from '../../core/stitch/stitcher.js'
import { fetchAsset, OPENCV_ASSET } from '../../shared/models.js'
import { createSaveControls } from '../../shared/save.js'
import { createWakeLock } from '../../shared/wake-lock.js'
import { coerceSettings } from '../../shared/settings.js'
import { showError, loadSettings, saveSettings } from '../../shared/ui.js'

const SETTINGS_KEY = 'live-panorama-settings'
const BUSY_KEY = 'sightline-pano-busy'
const ZOOM_CHOICES = [1, 1.5, 2]
const STRIP_HEIGHT = 64
const STAGE_WORDS = { match: 'Matching photos', warp: 'Warping', blend: 'Blending', encode: 'Saving' }
const MAX_SWEEP_DEG = 335 // capture stops 5 degrees under the stitch worker's 340 degree cap
const MOTION_WAIT_MS = 3000 // no gyroscope reading this long into capture: say so
const WAITING_MOTION = 'Waiting for the motion sensor…'

const $ = (id) => document.getElementById(id)
const el = {
  viewport: $('viewport'), guide: $('guide'), zoom: $('zoom'), status: $('status'), warning: $('warning'),
  strip: $('strip'), start: $('start'), done: $('done'), cancel: $('cancel'), loading: $('loading'),
  loadingText: $('loading-text'), bar: $('bar'), errors: $('errors'), result: $('result'), img: $('pano-img'), notes: $('notes'),
  share: $('share'), saveFile: $('save-file'), again: $('new'),
}
const params = new URLSearchParams(location.search)
const clipUrl = params.get('source') === 'file' ? params.get('clip') : null

const settings = coerceSettings(loadSettings(SETTINGS_KEY, { zoom: 1 }), { zoom: { default: 1, oneOf: ZOOM_CHOICES } })
const pano = window.__pano = { state: 'loading', photos: 0, warning: null, notes: [] }
const motion = createMotion(window)
const wake = createWakeLock()

let opencvBytes = null
let source = null
let session = null // the running panorama: { stitcher, rules, creating, photos, ending, over }
let resultUrl = null
let cameraEpoch = 0

const saver = createSaveControls({
  share: el.share, save: el.saveFile,
  onError: (err) => fail('Could not share', `${err.message || String(err)} Use Save file instead.`, 'Dismiss', clearErrors),
})

// ---------- state and small UI helpers ----------
function setState(state) {
  pano.state = state
  document.querySelector('.app').dataset.state = state
  const capturing = state === 'capturing'
  el.start.hidden = state !== 'loading' && state !== 'ready'
  el.start.disabled = state !== 'ready'
  el.done.hidden = !capturing
  el.cancel.hidden = !capturing && state !== 'stitching'
  el.strip.hidden = !capturing && state !== 'stitching'
  el.result.hidden = state !== 'result'
  el.viewport.style.visibility = state === 'result' ? 'hidden' : 'visible'
  for (const b of el.zoom.querySelectorAll('button')) b.disabled = capturing || state === 'stitching'
  if (state === 'loading') setStatus('Starting…')
  else if (state === 'ready') setStatus('Ready. Tap Start, then turn slowly.')
  else if (state === 'stitching') setStatus('Stitching…')
  if (state !== 'capturing') { setWarning(null); setGuide(0) }
}
function setStatus(text) { el.status.textContent = text }
// direction: 0 (not set yet) hides the guide; 1 / -1 shows the arrow pointing right / left.
function setGuide(direction) {
  el.guide.hidden = !direction
  if (direction) el.guide.dataset.direction = direction > 0 ? 'right' : 'left'
}
function setWarning(text) {
  if (text === pano.warning) return
  pano.warning = text
  el.warning.hidden = !text
  el.warning.textContent = text || ''
}
function setLoading(text) {
  el.loading.hidden = text == null
  if (text != null) el.loadingText.textContent = text
}
function clearErrors() { el.errors.replaceChildren() }
function fail(title, body, label, onClick) {
  clearErrors()
  showError(el.errors, { title, body, actions: [{ label, onClick }] })
}
function setBusy(on) {
  try {
    if (on) sessionStorage.setItem(BUSY_KEY, '1')
    else sessionStorage.removeItem(BUSY_KEY)
  } catch { /* storage blocked */ }
}

// ---------- boot: engine download and camera, in parallel ----------
async function loadEngine() {
  if (opencvBytes) return
  el.bar.style.width = '0'
  setLoading('Loading panorama engine…')
  try {
    opencvBytes = await fetchAsset(OPENCV_ASSET.url, {
      ...OPENCV_ASSET,
      onProgress: (loaded, total) => { if (total) el.bar.style.width = `${Math.min(100, (loaded / total) * 100)}%` },
    })
  } catch (err) {
    const body = err.name === 'ModelDownloadError'
      ? 'The panorama engine could not be downloaded. Check your connection and tap Retry.'
      : (err.message || String(err))
    fail('Could not load the panorama engine', body, 'Retry', () => { clearErrors(); loadEngine().then(maybeReady) })
  } finally {
    setLoading(null)
  }
}

async function debugFile() {
  if (!clipUrl) return undefined
  const res = await fetch(new URL(clipUrl, location.href))
  if (!res.ok) throw new Error(`Could not load clip ${clipUrl}: HTTP ${res.status}`)
  return res.blob()
}

async function openCamera() {
  const mine = ++cameraEpoch
  let src
  try {
    src = await LiveCameraSource.open({ debugFile: await debugFile(), motion })
  } catch (err) {
    if (mine !== cameraEpoch) return
    const body = err.name === 'CameraPermissionError'
      ? 'Camera access is off. Open Settings → Safari (or Brave) → Camera → Allow, then tap Retry.'
      : (err.message || String(err))
    return fail('Camera unavailable', body, 'Retry', () => { clearErrors(); openCamera().then(maybeReady) })
  }
  if (mine !== cameraEpoch) { src.stop(); return }
  source = src
  el.viewport.prepend(src.video)
  buildZoom(src)
}

function maybeReady() {
  if (pano.state === 'loading' && opencvBytes && source) setState('ready')
}

// ---------- zoom ----------
function buildZoom(src) {
  const range = zoomRange(src.track)
  const choices = range ? ZOOM_CHOICES.filter((z) => z >= range.min && z <= range.max) : []
  el.zoom.hidden = choices.length < 2
  if (!choices.includes(settings.zoom)) settings.zoom = 1
  el.zoom.replaceChildren(...choices.map((z) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pill'
    b.dataset.zoom = String(z)
    b.textContent = `${z}×`
    b.addEventListener('click', () => chooseZoom(z))
    return b
  }))
  syncZoom()
  if (!el.zoom.hidden && settings.zoom !== 1) {
    setZoom(src.track, settings.zoom).catch(() => { settings.zoom = 1; syncZoom() })
  }
}
function syncZoom() {
  for (const b of el.zoom.querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.zoom) === settings.zoom)
}
async function chooseZoom(z) {
  if (!source || session || z === settings.zoom) return
  try {
    await setZoom(source.track, z)
    settings.zoom = z
    saveSettings(SETTINGS_KEY, settings)
  } catch (err) {
    fail('Zoom unavailable', err.message || String(err), 'Dismiss', clearErrors)
  }
  syncZoom()
}

// ---------- capture ----------
// toThumb is grey and only for sharpness; the strip shows the real shot.
function addStripThumb(image) {
  const h = STRIP_HEIGHT
  const w = Math.max(1, Math.round(h * image.displayWidth / image.displayHeight))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(image, 0, 0, w, h)
  el.strip.append(canvas)
  el.strip.scrollLeft = el.strip.scrollWidth
}

async function captureLoop(s, src) {
  const started = performance.now()
  let waiting = false // showing WAITING_MOTION
  for await (const f of src.frames()) {
    try {
      if (s.over) break
      if (document.hidden) continue
      if (!f.motion) { // no gyroscope reading yet: skip, and say so after a while
        if (!waiting && performance.now() - started > MOTION_WAIT_MS) { waiting = true; setStatus(WAITING_MOTION) }
        continue
      }
      if (waiting) { waiting = false; setStatus(s.photos ? `Photos: ${s.photos}` : 'Turn slowly') }
      if (f.image.displayWidth !== s.width || f.image.displayHeight !== s.height) { setWarning('Keep the phone the same way up'); continue }
      const r = s.rules.update({ ...f.motion, sharpness: sharpness(toThumb(f.image)) })
      if (r.shoot) {
        const bitmap = await photoBitmap(f.image, s.photo)
        if (s.over) { bitmap.close(); break }
        s.stitcher.add(bitmap, { yawHint: s.rules.photosYaw[r.count - 1] }) // unwrapped: the sweep may pass 180
        addStripThumb(f.image)
        s.photos = pano.photos = r.count
        setStatus(`Photos: ${r.count}`)
      }
      setGuide(r.direction)
      setWarning(r.warning)
      if (r.done) { endSession('done'); break }
    } finally {
      f.image.close()
    }
  }
}

function resetToReady() {
  if (session) session.over = true
  session = null
  pano.photos = 0
  el.strip.replaceChildren()
  motion.stop()
  wake.release()
  setBusy(false)
  setState(opencvBytes && source ? 'ready' : 'loading')
}

async function onStart() {
  if (pano.state !== 'ready' || !source || !opencvBytes) return
  // iOS only shows the permission prompt from a tap, so this must be the first await.
  const permission = await motion.requestPermission()
  if (permission === 'denied') {
    return fail('Motion access needed', 'Panorama needs motion access. Reload the page and tap Allow.', 'Dismiss', clearErrors)
  }
  if (pano.state !== 'ready') return
  clearErrors()
  saver.clear()
  motion.start() // zeroed when capture starts, so turning during "Starting…" cannot set the direction

  const width = source.video.videoWidth || source.meta.width // live size: the phone may have been rotated since open
  const height = source.video.videoHeight || source.meta.height
  const photo = photoSize({ width, height }) // shots over 1920 px are stitched downscaled
  const zoom = settings.zoom
  const hfovDeg = displayedHfov({ lens: 'wide', width, height, zoom })
  const s = session = {
    rules: createCaptureRules({ hfovDeg, maxPhotos: maxPhotosFor(hfovDeg), maxSweepDeg: MAX_SWEEP_DEG }),
    stitcher: null, creating: null, photos: 0, ending: false, over: false, width, height, photo,
  }
  pano.photos = 0
  el.strip.replaceChildren()
  setBusy(true)
  wake.acquire()
  setState('capturing')
  setStatus('Starting…')
  s.creating = Stitcher.create({
    opencvBytes, focalPx: focalPx({ lens: 'wide', ...photo, zoom }), ...photo, mode: 'live',
    onProgress: (stage, done, total) => {
      if (pano.state === 'stitching') setStatus(`${STAGE_WORDS[stage] || 'Stitching'}… ${done}/${total}`)
    },
  })
  try {
    s.stitcher = await s.creating
  } catch (err) {
    if (session === s) {
      resetToReady()
      fail('Could not start the panorama', err.message || String(err), 'Dismiss', clearErrors)
    }
    return
  }
  if (s.ending || session !== s) return // Done or Cancel was tapped while the stitcher started: endSession takes over
  motion.zero()
  setStatus('Turn slowly')
  captureLoop(s, source).catch((err) => {
    if (session !== s || s.ending) return
    s.stitcher.cancel()
    resetToReady()
    fail('Capture stopped', err.message || String(err), 'Dismiss', clearErrors)
  })
}

// kind: 'done' | 'cancel'. Done runs once; Cancel is also accepted while stitching.
async function endSession(kind) {
  const s = session
  if (!s) return
  if (s.ending) {
    if (kind === 'cancel' && pano.state === 'stitching') s.stitcher.cancel() // finish() then rejects with AbortError
    return
  }
  s.ending = true
  s.over = true
  if (!s.stitcher) {
    try { s.stitcher = await s.creating } catch { return } // onStart reports the failure
  }
  if (kind === 'cancel') {
    s.stitcher.cancel()
    return resetToReady()
  }
  if (s.photos < 2) {
    s.stitcher.cancel()
    resetToReady()
    return fail('Not enough turning', 'Tap Start, then turn slowly so that at least two photos are taken.', 'Dismiss', clearErrors)
  }
  setState('stitching')
  try {
    const result = await s.stitcher.finish()
    if (session !== s) return
    showResult(result)
  } catch (err) {
    if (session !== s) return
    resetToReady()
    if (err.name !== 'AbortError') fail('Could not stitch the panorama', err.message || String(err), 'Dismiss', clearErrors)
  }
}

function showResult({ blob, notes }) {
  session = null
  motion.stop()
  wake.release()
  setBusy(false)
  if (resultUrl) URL.revokeObjectURL(resultUrl)
  resultUrl = URL.createObjectURL(blob)
  el.img.src = resultUrl
  pano.notes = notes || []
  el.notes.hidden = !pano.notes.length
  el.notes.textContent = pano.notes.join(' · ')
  saver.offer(blob, `sightline-panorama-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`)
  el.strip.replaceChildren()
  setState('result')
}

function newPanorama() {
  saver.clear()
  el.img.removeAttribute('src')
  if (resultUrl) URL.revokeObjectURL(resultUrl)
  resultUrl = null
  pano.photos = 0
  pano.notes = []
  setState('ready')
}

// ---------- events and lifecycle ----------
el.start.addEventListener('click', onStart)
el.done.addEventListener('click', () => endSession('done'))
el.cancel.addEventListener('click', () => endSession('cancel'))
el.again.addEventListener('click', newPanorama)
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake.request() })
window.addEventListener('pagehide', () => { source?.stop(); motion.stop() })

async function boot() {
  let lost = false
  try { lost = sessionStorage.getItem(BUSY_KEY) === '1' } catch { /* storage blocked */ }
  if (lost) {
    setBusy(false)
    showError(el.errors, {
      title: 'Panorama lost', body: 'The panorama was lost when the app was closed.',
      actions: [{ label: 'Dismiss', onClick: clearErrors }],
    })
  }
  setState('loading')
  await Promise.all([loadEngine(), openCamera()])
  maybeReady()
}
boot()
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload() }) // bfcache restore has a dead camera

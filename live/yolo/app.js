// Sightline Live: camera -> YOLO11n -> boxes, with optional annotated MP4 recording.
import '../../shared/register-sw.js'
import { listLenses, LiveCameraSource } from '../live-camera.js'
import { createDetector } from '../../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../../shared/models.js'
import { fitCover, drawDetections } from '../../shared/draw-boxes.js'
import { saveFile } from '../../shared/save.js'
import { showError, loadSettings, saveSettings } from '../../shared/ui.js'
import { createFpsMeter, formatStatus, lowFpsHint } from './status.js'
import { Recorder } from './recording.js'

const SETTINGS_KEY = 'live-yolo-settings'
const DEFAULTS = { conf: 0.35, inputSize: 320, showLabels: true }
const HINT_AFTER_MS = 3000 // let the fps meter warm up before warning

const $ = (id) => document.getElementById(id)
const el = {
  viewport: $('viewport'), canvas: $('overlay'), lens: $('lens'), rec: $('rec'), save: $('save'),
  download: $('download'), settingsBtn: $('settings-btn'), sheet: $('sheet'), status: $('status'),
  hint: $('hint'), loading: $('loading'), loadingText: $('loading-text'), bar: $('bar'), errors: $('errors'),
  conf: $('conf'), confVal: $('conf-val'), labels: $('labels'),
}
const ctx = el.canvas.getContext('2d')
const params = new URLSearchParams(location.search)
const clipUrl = params.get('source') === 'file' ? params.get('clip') : null

const settings = loadSettings(SETTINGS_KEY, DEFAULTS)
const stats = window.__liveStats = { framesSeen: 0, framesDetected: 0, lastCount: 0, backend: null, status: '' }

let detector = null
let source = null
let deviceId // undefined = default rear camera
let epoch = 0 // bumped whenever the camera session changes; stale loops exit
let loopDone = Promise.resolve()
let lastBoxes = []
let srcW = 0
let srcH = 0
let meter = createFpsMeter()
let detectStart = 0
let chain = Promise.resolve() // serialises start/stop/restart operations
const recorder = new Recorder()
let stopping = null // token of the stop-and-encode in flight
let blob = null
let linkUrl = null

const serial = (fn) => (chain = chain.then(fn).catch((err) => console.error(err)))

// ---------- errors and loading ----------
function clearErrors() { el.errors.replaceChildren() }
function fail(title, body, retry, label = 'Retry') {
  clearErrors()
  showError(el.errors, { title, body, actions: [{ label, onClick: () => serial(retry) }] })
}
const dismiss = async () => clearErrors()
function modelFail(err) {
  const body = err.name === 'ModelDownloadError'
    ? 'The model could not be downloaded. Check your connection and tap Retry.'
    : (err.message || String(err))
  fail('Could not load the model', body, boot)
}
function setLoading(text) {
  el.loading.hidden = text == null
  if (text != null) el.loadingText.textContent = text
}

// ---------- detector ----------
async function loadDetector() {
  if (detector && detector.inputSize === settings.inputSize) return
  detector?.dispose()
  detector = null
  el.bar.style.width = '0'
  setLoading(`Loading model (${settings.inputSize})…`)
  try {
    const modelBytes = await fetchModel(MODEL_URLS[settings.inputSize], (loaded, total) => {
      if (total) el.bar.style.width = `${Math.min(100, (loaded / total) * 100)}%`
    })
    detector = await createDetector({ modelBytes, inputSize: settings.inputSize, backend: 'auto' })
    stats.backend = detector.backend
  } finally {
    setLoading(null)
  }
}

// ---------- camera session ----------
async function debugFile() {
  if (!clipUrl) return undefined
  const res = await fetch(new URL(clipUrl, location.href))
  if (!res.ok) throw new Error(`Could not load clip ${clipUrl}: HTTP ${res.status}`)
  return res.blob()
}

function watchFramesSeen(video, mine) {
  if (typeof video.requestVideoFrameCallback !== 'function') return
  const cb = () => {
    if (mine !== epoch) return
    stats.framesSeen++
    video.requestVideoFrameCallback(cb)
  }
  video.requestVideoFrameCallback(cb)
}

async function openCamera() {
  clearErrors()
  const mine = ++epoch
  let src
  try {
    src = await LiveCameraSource.open({ deviceId, debugFile: await debugFile() })
  } catch (err) {
    if (err.name === 'CameraPermissionError') {
      return fail('Camera unavailable',
        'Camera access is off. Open Settings → Safari (or Brave) → Camera → Allow, then tap Retry.', openCamera)
    }
    return fail('Camera unavailable', err.message || String(err), openCamera)
  }
  if (mine !== epoch) { src.stop(); return }
  source = src
  el.viewport.prepend(src.video)
  meter = createFpsMeter()
  detectStart = 0
  watchFramesSeen(src.video, mine)
  el.rec.disabled = false
  loopDone = detectLoop(src, mine)
  populateLenses(src)
}

async function closeCamera() {
  epoch++
  abortRecording()
  const s = source
  source = null
  s?.stop()
  await loopDone
  s?.video.remove()
  lastBoxes = []
  el.rec.disabled = true
}

async function populateLenses(src) {
  if (clipUrl) return
  try {
    const lenses = await listLenses()
    if (src !== source || !lenses.length) return
    el.lens.replaceChildren(...lenses.map((l) => new Option(l.label, l.deviceId)))
    const active = src.video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId
    if (active) el.lens.value = active
    el.lens.hidden = lenses.length < 2
  } catch { /* lens list is optional */ }
}

async function detectLoop(src, mine) {
  const stale = () => mine !== epoch
  try {
    for await (const { image, t } of src.frames()) {
      try {
        if (stale()) break
        srcW = image.displayWidth
        srcH = image.displayHeight
        if (typeof src.video.requestVideoFrameCallback !== 'function') stats.framesSeen++
        const boxes = await detector.detect(image, { conf: settings.conf, iou: 0.45 })
        if (stale()) break
        lastBoxes = boxes
        stats.framesDetected++
        stats.lastCount = boxes.length
        detectStart ||= performance.now()
        meter.tick(performance.now())
        refreshStatus()
        if (recorder.active) await recordFrame(image, boxes, t)
      } catch (err) {
        if (err.name === 'InvalidImageError') continue // frame had no size yet: skip it
        throw err
      } finally {
        image.close()
      }
    }
  } catch (err) {
    if (stale()) return
    abortRecording()
    src.stop()
    fail('Detection stopped', err.message || String(err), async () => { await closeCamera(); await openCamera() })
  }
}

// ---------- overlay, status ----------
function refreshStatus() {
  const now = performance.now()
  const fps = meter.fpsAt(now)
  const text = !source || !detector ? 'Starting…'
    : stats.framesDetected ? formatStatus({ count: lastBoxes.length, backend: detector.backend, fps })
    : 'Detecting…'
  if (text !== stats.status) { stats.status = text; el.status.textContent = text }
  const hint = stats.framesDetected && now - detectStart > HINT_AFTER_MS ? lowFpsHint(fps, recorder.active) : null
  el.hint.hidden = !hint
  if (hint) el.hint.textContent = hint
}

function drawFrame() {
  requestAnimationFrame(drawFrame)
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(el.canvas.clientWidth * dpr)
  const h = Math.round(el.canvas.clientHeight * dpr)
  if (el.canvas.width !== w || el.canvas.height !== h) { el.canvas.width = w; el.canvas.height = h }
  ctx.clearRect(0, 0, w, h)
  if (w && h && srcW && lastBoxes.length) {
    drawDetections(ctx, lastBoxes, { ...fitCover(srcW, srcH, w, h), showLabels: settings.showLabels, dpr })
  }
  refreshStatus()
  if (recorder.active) {
    const s = Math.floor(recorder.elapsed)
    el.rec.textContent = `Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
}

// ---------- recording ----------
function clearSaved() {
  blob = null
  if (linkUrl) URL.revokeObjectURL(linkUrl)
  linkUrl = null
  el.save.hidden = true
  el.download.hidden = true
}

function resetRecButton() {
  el.rec.classList.remove('active')
  el.rec.textContent = 'Record'
  el.rec.disabled = !source
  stopping = null
}

function abortRecording() {
  if (!recorder.active && !stopping) return
  recorder.abort()
  resetRecButton()
}

async function recordFrame(image, boxes, t) {
  try {
    await recorder.addFrame(image, boxes, t, settings.showLabels)
  } catch (err) {
    abortRecording()
    fail('Recording stopped', err.message || String(err), dismiss, 'Dismiss')
  }
}

async function toggleRecording() {
  if (stopping || !source) return
  if (!recorder.active) {
    clearSaved()
    try {
      await recorder.start(source.meta)
    } catch (err) {
      return fail('Cannot record', err.message || String(err), dismiss, 'Dismiss')
    }
    el.rec.classList.add('active')
    return
  }
  const token = stopping = {}
  el.rec.disabled = true
  el.rec.textContent = 'Saving…'
  try {
    const result = await recorder.stop()
    if (stopping === token) { blob = result; el.save.hidden = false } // else aborted while encoding
  } catch (err) {
    if (stopping === token) fail('Recording failed', err.message || String(err), dismiss, 'Dismiss')
  }
  if (stopping === token) resetRecButton()
}

// Direct click handler: saveFile needs the user gesture, so nothing is awaited before it.
function onSave() {
  if (!blob) return
  const filename = `sightline-live-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`
  const done = saveFile(blob, filename)
  done.then((result) => {
    if (result === 'shared') return
    if (linkUrl) URL.revokeObjectURL(linkUrl)
    linkUrl = URL.createObjectURL(blob)
    el.download.href = linkUrl
    el.download.download = filename
    el.download.hidden = false
  })
}

// ---------- settings ----------
function syncSettingsUi() {
  el.conf.value = settings.conf
  el.confVal.textContent = Number(settings.conf).toFixed(2)
  el.labels.classList.toggle('active', settings.showLabels)
  for (const b of el.sheet.querySelectorAll('[data-size]')) {
    b.classList.toggle('active', Number(b.dataset.size) === settings.inputSize)
  }
}

// Restart on the new model size (settings.inputSize is already updated).
async function changeInputSize() {
  await closeCamera()
  await boot()
}

el.conf.addEventListener('input', () => {
  settings.conf = Number(el.conf.value)
  saveSettings(SETTINGS_KEY, settings)
  syncSettingsUi()
})
el.labels.addEventListener('click', () => {
  settings.showLabels = !settings.showLabels
  saveSettings(SETTINGS_KEY, settings)
  syncSettingsUi()
})
for (const b of el.sheet.querySelectorAll('[data-size]')) {
  b.addEventListener('click', () => {
    const size = Number(b.dataset.size)
    if (size === settings.inputSize) return
    settings.inputSize = size
    saveSettings(SETTINGS_KEY, settings)
    syncSettingsUi()
    serial(changeInputSize)
  })
}
el.settingsBtn.addEventListener('click', () => {
  el.sheet.hidden = !el.sheet.hidden
  el.settingsBtn.setAttribute('aria-expanded', String(!el.sheet.hidden))
})
el.lens.addEventListener('change', () => serial(async () => {
  deviceId = el.lens.value
  await closeCamera()
  await openCamera()
}))
el.rec.addEventListener('click', toggleRecording)
el.save.addEventListener('click', onSave)

// ---------- lifecycle ----------
let hiddenStop = false
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    abortRecording()
    hiddenStop = !!source
    if (hiddenStop) serial(closeCamera)
  } else if (hiddenStop) {
    hiddenStop = false
    serial(openCamera)
  }
})
window.addEventListener('pagehide', () => { abortRecording(); source?.stop() })

// The lens list is filled in by openCamera, once permission makes the labels available.
async function boot() {
  try { await loadDetector() } catch (err) { return modelFail(err) }
  await openCamera()
}

syncSettingsUi()
if (clipUrl) el.lens.hidden = true
requestAnimationFrame(drawFrame)
serial(boot)

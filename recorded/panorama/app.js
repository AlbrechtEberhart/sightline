// Sightline Studio Panorama: choose a slow-pan clip -> scan it once for sharp frames that each add new scene
// -> stitch them in a worker -> offer the JPEG through Share… / Save file.
import '../../shared/register-sw.js'
import { FileVideoSource } from '../video-source.js'
import { scanClip } from './scan.js'
import { focalPx } from '../../core/stitch/camera-model.js'
import { Stitcher } from '../../core/stitch/stitcher.js'
import { fetchAsset, OPENCV_ASSET } from '../../shared/models.js'
import { createSaveControls } from '../../shared/save.js'
import { createWakeLock } from '../../shared/wake-lock.js'
import { coerceSettings } from '../../shared/settings.js'
import { showError, loadSettings, saveSettings } from '../../shared/ui.js'

const SETTINGS_KEY = 'sightline-studio-panorama'
const BUSY_KEY = 'sightline-pano-busy'
const SCHEMA = { lens: { default: 'wide', oneOf: ['wide', 'ultrawide'] } }
const STAGE_WORDS = { match: 'Matching photos', warp: 'Warping', blend: 'Blending', encode: 'Saving' }
const STRIP_HEIGHT = 48

const $ = (id) => document.getElementById(id)
const el = {
  errors: $('errors'), lost: $('lost'), file: $('file'), clipName: $('clip-name'), clipInfo: $('clip-info'),
  loadingText: $('loading-text'), bar: $('bar'), scan: $('scan'),
  scanBar: $('scan-bar'), scanText: $('scan-text'), scanCancel: $('scan-cancel'), stripScan: $('strip-scan'),
  pickedText: $('picked-text'), stripPicked: $('strip-picked'), pickedNotes: $('picked-notes'),
  stitch: $('stitch'), pickedBack: $('picked-back'),
  stitchBar: $('stitch-bar'), stitchText: $('stitch-text'), stitchCancel: $('stitch-cancel'),
  img: $('pano-img'), resultNotes: $('result-notes'), share: $('share'), saveFile: $('save-file'),
  panels: {
    loading: $('panel-loading'), choose: $('panel-choose'), ready: $('panel-ready'), scanning: $('panel-scanning'),
    picked: $('panel-picked'), stitching: $('panel-stitching'), result: $('panel-result'),
  },
}
const PANEL_FOR = { loading: 'loading', choose: 'choose', ready: 'ready', scanning: 'scanning', picked: 'picked', stitching: 'stitching', result: 'result', error: null }

const settings = coerceSettings(loadSettings(SETTINGS_KEY, { lens: 'wide' }), SCHEMA)
const studio = window.__studioPano = { state: 'loading', picked: 0, messages: [], notes: [] }
const wake = createWakeLock()
const saver = createSaveControls({
  share: el.share, save: el.saveFile,
  onError: (err) => fail('Could not share', `${message(err)} Use Save file instead.`, [{ label: 'Dismiss', onClick: clearErrors }]),
})

let opencvBytes = null
let file = null // the chosen File
let source = null // FileVideoSource of `file`
let run = null // the scan/stitch in flight: { ac, stitcher, creating, over }
let resultUrl = null

const message = (err) => err?.message || String(err)

// ---------- state, errors ----------
function setState(state) {
  studio.state = state
  const shown = PANEL_FOR[state]
  for (const [name, panel] of Object.entries(el.panels)) panel.hidden = name !== shown
}
function clearErrors() { el.errors.replaceChildren() }
function fail(title, body, actions) {
  clearErrors()
  setState('error')
  showError(el.errors, { title, body, actions })
}
const chooseAction = { label: 'Choose another clip', onClick: () => chooseAnother() }
const readyAction = (label) => ({ label, onClick: () => { clearErrors(); setState('ready') } })
function setBar(bar, fraction) { bar.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%` }
function setBusy(on) {
  try {
    if (on) sessionStorage.setItem(BUSY_KEY, '1')
    else sessionStorage.removeItem(BUSY_KEY)
  } catch { /* storage blocked */ }
}
function setNotes(notes) {
  studio.notes = notes
  for (const p of [el.pickedNotes, el.resultNotes]) {
    p.hidden = !notes.length
    p.textContent = notes.join(' · ')
  }
}

// ---------- engine ----------
async function loadEngine() {
  clearErrors()
  setState('loading')
  setBar(el.bar, 0)
  el.loadingText.textContent = 'Loading panorama engine…'
  try {
    opencvBytes = await fetchAsset(OPENCV_ASSET.url, {
      ...OPENCV_ASSET,
      onProgress: (loaded, total) => { if (total) setBar(el.bar, loaded / total) },
    })
  } catch (err) {
    const body = err.name === 'ModelDownloadError'
      ? 'The panorama engine could not be downloaded. Check your connection and tap Retry.' : message(err)
    return fail('Could not load the panorama engine', body, [{ label: 'Retry', onClick: loadEngine }])
  }
  setState('choose')
}

// ---------- choose ----------
function mmss(seconds) {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Stops the scan/stitch in flight. The busy flag stays set on pagehide, so a closed app is reported as lost work.
function endRun({ clearBusy = true } = {}) {
  const r = run
  run = null
  if (!r) return
  r.over = true
  r.ac.abort()
  if (r.stitcher) r.stitcher.cancel()
  else r.creating?.then((s) => s.cancel(), () => {}) // create cannot be cancelled mid-init
  wake.release()
  if (clearBusy) setBusy(false)
}

function clearStrips() {
  el.stripScan.replaceChildren()
  el.stripPicked.replaceChildren()
}

function clearResult() {
  saver.clear()
  el.img.removeAttribute('src')
  if (resultUrl) URL.revokeObjectURL(resultUrl)
  resultUrl = null
}

function resetClip() {
  endRun()
  clearErrors()
  clearResult()
  clearStrips()
  source?.stop()
  source = null
  file = null
  studio.picked = 0
  studio.messages = []
  setNotes([])
  el.clipName.textContent = ''
}

// Called from a click, so the file picker may open straight away.
function chooseAnother() {
  resetClip()
  setState('choose')
  el.file.value = ''
  try { el.file.click() } catch { /* the visible input still works */ }
}

async function openClip(f) {
  resetClip()
  file = f
  el.clipName.textContent = f.name
  el.loadingText.textContent = 'Opening clip…'
  setBar(el.bar, 0)
  setState('loading')
  let src
  try {
    src = await FileVideoSource.open(f)
  } catch (err) {
    if (file !== f) return
    if (err.name === 'UnsupportedCodecError') return fail("Can't decode this video", err.message, [chooseAction])
    return fail("Couldn't open this video", message(err), [chooseAction])
  }
  if (file !== f) { src.stop(); return } // another clip was chosen meanwhile
  source = src
  const m = src.meta
  if (!(m.frameCount > 0 && m.fps > 0)) return fail("Couldn't open this video", 'This video has no frames.', [chooseAction])
  el.clipInfo.textContent = `${m.width}×${m.height} · ${m.fps.toFixed(m.fps % 1 ? 2 : 0)} fps · ${mmss(m.duration)} · ${m.frameCount} frames`
  setState('ready')
}

// ---------- scan ----------
function addStripThumb(bitmap) {
  const w = Math.max(1, Math.round(STRIP_HEIGHT * bitmap.width / bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = STRIP_HEIGHT
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, STRIP_HEIGHT)
  el.stripScan.append(canvas)
}

async function onScan() {
  if (studio.state !== 'ready' || !source || !opencvBytes) return
  clearErrors()
  clearResult()
  clearStrips()
  studio.picked = 0
  studio.messages = []
  setNotes([])
  const { width, height } = source.meta
  const r = run = { ac: new AbortController(), stitcher: null, creating: null, over: false }
  setBusy(true)
  wake.acquire()
  setBar(el.scanBar, 0)
  el.scanText.textContent = 'Starting…'
  setState('scanning')
  r.creating = Stitcher.create({
    opencvBytes, focalPx: focalPx({ lens: settings.lens, width, height }), width, height, mode: 'studio',
    onProgress: (stage, done, total) => {
      if (studio.state === 'stitching') {
        setBar(el.stitchBar, total ? done / total : 0)
        el.stitchText.textContent = `${STAGE_WORDS[stage] || 'Stitching'}… ${done}/${total}`
      }
    },
  })
  try {
    r.stitcher = await r.creating
  } catch (err) {
    if (run !== r) return
    endRun()
    return fail('Could not start the panorama', message(err), [readyAction('Back'), chooseAction])
  }
  if (r.over) { r.stitcher.cancel(); return } // cancelled while the engine started
  el.scanText.textContent = 'Scanning… 0%'
  let res
  try {
    res = await scanClip(source, {
      stitcher: r.stitcher, signal: r.ac.signal, onPick: addStripThumb,
      onProgress: (fraction) => {
        if (run !== r) return
        setBar(el.scanBar, fraction)
        el.scanText.textContent = `Scanning… ${Math.floor(fraction * 100)}%`
        studio.picked = el.stripScan.childElementCount
      },
    })
  } catch (err) {
    if (run !== r) return // cancelled
    endRun()
    clearStrips()
    console.error(err)
    return fail('Scan stopped', message(err), [readyAction('Back'), chooseAction])
  }
  if (run !== r) return
  if (res.error) {
    endRun() // discards the picks already inside the worker
    clearStrips()
    return fail(res.error, 'Pan the camera slowly across the scene while recording, then choose the clip again.',
      [readyAction('Back'), chooseAction])
  }
  studio.picked = res.used.length
  studio.messages = res.messages
  el.stripPicked.replaceChildren(...el.stripScan.children)
  el.pickedText.textContent = `${res.used.length} frames picked`
  setNotes(res.messages)
  wake.release() // only the scan and the stitch hold the screen awake
  setState('picked')
}

function cancelToReady() {
  endRun()
  clearStrips()
  studio.picked = 0
  setNotes([])
  clearErrors()
  setState('ready')
}

// ---------- stitch ----------
const outName = () => `${(file?.name || 'clip').replace(/\.[^.]*$/, '') || 'clip'}-panorama.jpg`

async function onStitch() {
  const r = run
  if (studio.state !== 'picked' || !r?.stitcher) return
  setBar(el.stitchBar, 0)
  el.stitchText.textContent = 'Starting…'
  wake.acquire()
  setState('stitching')
  try {
    const result = await r.stitcher.finish()
    if (run !== r) return
    endRun() // releases the wake lock and busy flag; the stitcher has already closed itself
    clearResult()
    resultUrl = URL.createObjectURL(result.blob)
    el.img.src = resultUrl
    setNotes([...studio.messages, ...(result.notes || [])])
    saver.offer(result.blob, outName())
    setState('result')
  } catch (err) {
    if (run !== r) return
    endRun()
    if (err.name === 'AbortError') return
    console.error(err)
    fail('Could not stitch the panorama', message(err), [readyAction('Back'), chooseAction])
  }
}

// ---------- lens setting ----------
function syncLens() {
  for (const b of document.querySelectorAll('[data-lens]')) b.classList.toggle('active', b.dataset.lens === settings.lens)
}
for (const b of document.querySelectorAll('[data-lens]')) {
  b.addEventListener('click', () => { settings.lens = b.dataset.lens; saveSettings(SETTINGS_KEY, settings); syncLens() })
}

// ---------- wiring, lifecycle ----------
el.file.addEventListener('change', () => {
  const f = el.file.files?.[0]
  if (f && opencvBytes) openClip(f)
})
el.scan.addEventListener('click', onScan)
el.scanCancel.addEventListener('click', cancelToReady)
el.stitch.addEventListener('click', onStitch)
el.pickedBack.addEventListener('click', cancelToReady)
el.stitchCancel.addEventListener('click', cancelToReady)
for (const b of document.querySelectorAll('.choose-another')) b.addEventListener('click', chooseAnother)
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake.request() })
window.addEventListener('pagehide', () => { endRun({ clearBusy: false }); source?.stop() })
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload() }) // bfcache restore has dead workers

let lost = false
try { lost = sessionStorage.getItem(BUSY_KEY) === '1' } catch { /* storage blocked */ }
syncLens()
loadEngine()
if (lost) {
  setBusy(false)
  showError(el.lost, {
    title: 'Panorama lost', body: 'The panorama was lost when the app was closed.',
    actions: [{ label: 'Dismiss', onClick: () => el.lost.replaceChildren() }],
  })
}

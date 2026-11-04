// Sightline Studio: choose a recorded clip -> YOLO11n on every frame (offline, boxes only)
// -> review with the boxes overlaid -> export an annotated MP4 with the original audio.
import '../../shared/register-sw.js'
import { FileVideoSource } from '../video-source.js'
import { processClip, estimateSeconds, summarize } from './process.js'
import { exportClip } from './export.js'
import { createReview } from './review.js'
import { createWakeLock } from './wake-lock.js'
import { createDetector } from '../../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../../shared/models.js'
import { createSaveControls } from '../../shared/save.js'
import { showError, formatEta, loadSettings, saveSettings } from '../../shared/ui.js'

const SETTINGS_KEY = 'recorded-yolo-settings'
const DEFAULTS = { conf: 0.35, inputSize: 640, step: 1, showLabels: true }
const ETA_AFTER_FRAMES = 5 // the first frames include warm-up, so their ETA is meaningless

const $ = (id) => document.getElementById(id)
const el = {
  errors: $('errors'), file: $('file'), clipName: $('clip-name'), clipInfo: $('clip-info'),
  conf: $('conf'), confVal: $('conf-val'), labels: $('labels'), process: $('process'),
  procBar: $('proc-bar'), procText: $('proc-text'), procCancel: $('proc-cancel'),
  summary: $('summary'), exportBtn: $('export'), expCancel: $('exp-cancel'), expProgress: $('export-progress'),
  expBar: $('exp-bar'), expText: $('exp-text'), share: $('share'), saveFile: $('save-file'), back: $('back'),
  video: $('video'), overlay: $('overlay'),
  panels: { choose: $('panel-choose'), settings: $('panel-settings'), processing: $('panel-processing'), review: $('panel-review') },
}
const PANEL_FOR = { choose: 'choose', settings: 'settings', processing: 'processing', review: 'review', exporting: 'review', done: 'review', error: null }

// Stored settings may be hand-edited or from an older version: coerce each field to a valid value.
function validSettings(raw) {
  return {
    conf: typeof raw.conf === 'number' && Number.isFinite(raw.conf) ? Math.min(0.9, Math.max(0.1, raw.conf)) : DEFAULTS.conf,
    inputSize: raw.inputSize === 320 || raw.inputSize === 640 ? raw.inputSize : DEFAULTS.inputSize,
    step: raw.step === 1 || raw.step === 2 ? raw.step : DEFAULTS.step,
    showLabels: typeof raw.showLabels === 'boolean' ? raw.showLabels : DEFAULTS.showLabels,
  }
}
const settings = validSettings(loadSettings(SETTINGS_KEY, DEFAULTS))
const studio = window.__studio = { state: 'choose' }
const review = createReview(el.video, el.overlay)
const wake = createWakeLock()
const saver = createSaveControls({
  share: el.share, save: el.saveFile,
  onError: (err) => {
    console.error(err)
    showError(el.errors, { title: 'Could not share', body: `${message(err)} Use Save file instead.`,
      actions: [{ label: 'Dismiss', onClick: clearErrors }] })
  },
})

let file = null // the chosen File
let source = null // FileVideoSource of `file`, reused for every processing run
let videoUrl = null
let detector = null
let result = null // completed processClip result
let reviewing = null // the result the review overlay is showing
let procEpoch = 0 // bumped by Cancel / a new clip: a stale processing run discards its result
let run = null // the processClip call in flight: { ac, paused }
let pendingResume = null // a run paused because the page was hidden: resume when visible
let exportRun = null // { ac, cancelled, hidden }
let chain = Promise.resolve()
const serial = (fn) => (chain = chain.then(fn).catch((err) => unknownFail(err)))

// ---------- state, errors ----------
function setState(state) {
  studio.state = state
  const shown = PANEL_FOR[state]
  for (const [name, panel] of Object.entries(el.panels)) panel.hidden = name !== shown
  const exporting = state === 'exporting'
  el.expProgress.hidden = !exporting
  el.exportBtn.hidden = exporting
  el.exportBtn.textContent = state === 'done' ? 'Export again' : 'Export MP4'
  el.expCancel.hidden = !exporting
  if (state !== 'done') saver.clear() // a finished export is offered only while its 'done' state lasts
  el.back.disabled = exporting
  for (const b of document.querySelectorAll('.choose-another')) b.disabled = exporting
  if (state === 'review' || state === 'done' || state === 'exporting') {
    if (result && reviewing !== result) { review.show(videoUrl, result, source.meta, settings.showLabels); reviewing = result }
  } else if (state === 'error') {
    el.video.pause()
  } else {
    review.hide()
    reviewing = null
  }
}
function clearErrors() { el.errors.replaceChildren() }
function fail(title, body, actions) {
  clearErrors()
  setState('error')
  showError(el.errors, { title, body, actions })
}
const chooseAction = { label: 'Choose another clip', onClick: () => chooseAnother() }
const retryAction = (fn, label = 'Retry') => ({ label, onClick: () => { clearErrors(); serial(fn) } })
const toState = (label, state) => ({ label, onClick: () => { clearErrors(); setState(state) } })
const message = (err) => err?.message || String(err)

function unknownFail(err) {
  console.error(err)
  wake.release()
  fail('Something went wrong', message(err), [chooseAction])
}

// ---------- choose ----------
function mmss(seconds) {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function stopWork() {
  procEpoch++
  run?.ac.abort()
  run = null
  pendingResume = null
  if (exportRun) { exportRun.cancelled = true; exportRun.ac.abort() }
  wake.release()
}

function resetClip() {
  stopWork()
  clearErrors()
  saver.clear()
  review.clear()
  reviewing = null
  source?.stop()
  source = null
  result = null
  file = null
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = null
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
  try {
    source = await FileVideoSource.open(f)
  } catch (err) {
    if (err.name === 'UnsupportedCodecError') return fail("Can't decode this video", err.message, [chooseAction])
    if (err.name === 'VideoOpenError') return fail("Couldn't open this video", err.message, [chooseAction])
    return fail("Couldn't open this video", message(err), [chooseAction])
  }
  const m = source.meta
  if (!(m.frameCount > 0 && m.fps > 0)) return fail("Couldn't open this video", 'This video has no frames.', [chooseAction])
  videoUrl = URL.createObjectURL(f)
  el.clipInfo.textContent = `${m.width}×${m.height} · ${m.fps.toFixed(m.fps % 1 ? 2 : 0)} fps · ${mmss(m.duration)} · ` +
    `${m.frameCount} frames · ${m.hasAudio ? 'with audio' : 'no audio'}`
  setState('settings')
}

// ---------- processing ----------
async function loadDetector(mine) {
  if (detector && detector.inputSize === settings.inputSize) return
  detector?.dispose()
  detector = null
  setBar(el.procBar, 0)
  el.procText.textContent = `Loading model (${settings.inputSize})…`
  const modelBytes = await fetchModel(MODEL_URLS[settings.inputSize], (loaded, total) => {
    if (total && mine === procEpoch) setBar(el.procBar, (loaded / total) * 100)
  })
  const d = await createDetector({ modelBytes, inputSize: settings.inputSize, backend: 'auto' })
  if (detector) detector.dispose() // cannot happen inside serial, but never leak a session
  detector = d
}

function setBar(bar, pct) { bar.style.width = `${Math.max(0, Math.min(100, pct))}%` }

function dropDetector() {
  try { detector?.dispose() } catch { /* already broken */ }
  detector = null
}

/** Runs (or, with `prior`, resumes) processing. Always called through serial(). */
async function processRun(prior = null) {
  const mine = ++procEpoch
  clearErrors()
  setBar(el.procBar, prior ? ((prior.lastFrame + 1) / source.meta.frameCount) * 100 : 0)
  el.procText.textContent = prior ? 'Resuming…' : 'Starting…'
  setState('processing')
  try {
    await loadDetector(mine)
  } catch (err) {
    if (mine !== procEpoch) return
    dropDetector()
    const body = err.name === 'ModelDownloadError'
      ? 'The model could not be downloaded. Check your connection and tap Retry.' : message(err)
    return fail('Could not load the model', body, [retryAction(() => processRun(prior)), toState('Settings', 'settings')])
  }
  if (mine !== procEpoch) return
  const meta = source.meta
  if (!prior && meta.duration > 120) {
    const about = formatEta(estimateSeconds(meta.frameCount, settings.step, detector.warmupMs))
    if (!confirm(`Clip is ${mmss(meta.duration)} long. Processing will take about ${about}. Continue?`)) return setState('settings')
  }
  const startFrame = prior ? prior.lastFrame + 1 : 0
  const n = meta.frameCount
  setBar(el.procBar, (startFrame / n) * 100)
  el.procText.textContent = `${Math.floor((startFrame / n) * 100)}% · ETA —`
  const current = run = { ac: new AbortController(), paused: false }
  if (document.hidden) { current.paused = true; current.ac.abort() } // hidden again before the run started
  wake.acquire()
  const res = await processClip(source, detector, {
    step: settings.step, conf: settings.conf, iou: 0.45, startFrame, prior, signal: current.ac.signal,
    onProgress: (done, _total, eta) => {
      if (mine !== procEpoch) return
      const pct = Math.floor(((startFrame + done) / n) * 100)
      setBar(el.procBar, pct)
      el.procText.textContent = `${pct}% · ETA ${done > ETA_AFTER_FRAMES ? formatEta(eta) : '—'}`
    },
  })
  if (run === current) run = null
  if (mine !== procEpoch) return // cancelled or a new clip: discard the partial result
  if (res.completed) {
    wake.release()
    result = res
    renderSummary()
    return setState('review')
  }
  if (res.error) {
    wake.release()
    if (res.error.name === 'TruncatedClipError') {
      return fail('Clip ended early', `The video stopped decoding after frame ${res.lastFrame + 1} of ${n}. ` +
        'The file may be damaged or incomplete.', [chooseAction, toState('Settings', 'settings')])
    }
    console.error(res.error)
    if (res.error.name !== 'VideoDecodeError') dropDetector() // the detector may be what broke
    return fail('Processing stopped', message(res.error), [retryAction(() => processRun(res)), chooseAction])
  }
  // A resume that was not interrupted by a hide yet stored nothing will not get further by retrying.
  if (!current.paused && prior && res.lastFrame === prior.lastFrame) {
    wake.release()
    return fail('Processing stopped', `Processing made no progress after resuming at frame ${startFrame + 1}. ` +
      'Tap Retry to continue.', [retryAction(() => processRun(res)), chooseAction])
  }
  // Not completed, no error, not cancelled: the page was hidden (iOS suspends it). Resume once visible.
  el.procText.textContent = `Paused at ${Math.floor(((res.lastFrame + 1) / n) * 100)}% · resumes when the app is open`
  if (!document.hidden) return processRun(res)
  pendingResume = res
}

function cancelProcessing() {
  stopWork()
  setState('settings')
}

function renderSummary() {
  const rows = summarize(result.detections)
  el.summary.replaceChildren(...(rows.length ? rows : [null]).map((r) => {
    const li = document.createElement('li')
    li.textContent = r ? `${r.label} ×${r.frames} frames` : 'Nothing detected'
    return li
  }))
}

// ---------- export ----------
const exportName = () => `${(file?.name || 'clip').replace(/\.[^.]*$/, '') || 'clip'}-yolo.mp4`

async function exportRunFn() {
  if (!result || !file) return
  if (source.meta.duration > 180 && !confirm(`Exporting a ${mmss(source.meta.duration)} clip needs a lot of memory ` +
    'on iPhone and may fail. Shorter clips (under 3 minutes) are safest. Export anyway?')) {
    // Declined: stay on review (a Retry from the error panel comes back to review too).
    if (studio.state === 'error') { clearErrors(); setState('review') }
    return
  }
  clearErrors()
  saver.clear()
  const current = exportRun = { ac: new AbortController(), cancelled: false, hidden: false }
  setBar(el.expBar, 0)
  el.expText.textContent = 'Exporting… 0%'
  setState('exporting')
  wake.acquire()
  try {
    const out = await exportClip(file, result.detections, {
      showLabels: settings.showLabels, signal: current.ac.signal,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 100)
        setBar(el.expBar, pct)
        el.expText.textContent = `Exporting… ${pct}%`
      },
    })
    if (exportRun !== current) return
    saver.offer(out, exportName())
    setState('done')
  } catch (err) {
    if (current.cancelled) { if (studio.state === 'exporting') setState('review'); return }
    if (current.hidden) {
      return fail('Export stopped', 'The app went to the background, so the export was stopped.',
        [retryAction(exportRunFn, 'Export again'), toState('Back to review', 'review')])
    }
    console.error(err)
    if (err.name === 'EncoderUnsupportedError') {
      return fail("Can't export on this browser", 'H.264 video encoding is not available here. ' +
        'Try the latest Safari or Brave.', [toState('Back to review', 'review'), chooseAction])
    }
    if (err.name === 'UnsupportedCodecError' || err.name === 'VideoOpenError') {
      return fail("Couldn't read this video", err.message, [chooseAction])
    }
    fail('Export failed', message(err), [retryAction(exportRunFn), toState('Back to review', 'review')])
  } finally {
    if (exportRun === current) exportRun = null
    wake.release()
  }
}

// ---------- settings ----------
function syncSettingsUi() {
  el.conf.value = settings.conf
  el.confVal.textContent = Number(settings.conf).toFixed(2)
  el.labels.classList.toggle('active', settings.showLabels)
  for (const b of document.querySelectorAll('[data-size]')) b.classList.toggle('active', Number(b.dataset.size) === settings.inputSize)
  for (const b of document.querySelectorAll('[data-step]')) b.classList.toggle('active', Number(b.dataset.step) === settings.step)
}
function changeSetting(patch) {
  Object.assign(settings, patch)
  saveSettings(SETTINGS_KEY, settings)
  syncSettingsUi()
  // The detector for the new size is created on Process.
  if (detector && detector.inputSize !== settings.inputSize) dropDetector()
}

el.conf.addEventListener('input', () => changeSetting({ conf: Number(el.conf.value) }))
el.labels.addEventListener('click', () => changeSetting({ showLabels: !settings.showLabels }))
for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => changeSetting({ inputSize: Number(b.dataset.size) }))
for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => changeSetting({ step: Number(b.dataset.step) }))

// ---------- wiring, lifecycle ----------
el.file.addEventListener('change', () => {
  const f = el.file.files?.[0]
  if (f) serial(() => openClip(f))
})
el.process.addEventListener('click', () => { if (source) serial(() => processRun()) })
el.procCancel.addEventListener('click', cancelProcessing)
el.exportBtn.addEventListener('click', () => serial(exportRunFn))
el.expCancel.addEventListener('click', () => { if (exportRun) { exportRun.cancelled = true; exportRun.ac.abort() } })
el.back.addEventListener('click', () => setState('settings'))
for (const b of document.querySelectorAll('.choose-another')) b.addEventListener('click', chooseAnother)

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Stop cleanly before iOS suspends the page (and reclaims the decoder): processing resumes,
    // an export is aborted.
    if (run) { run.paused = true; run.ac.abort() }
    if (exportRun) { exportRun.hidden = true; exportRun.ac.abort() }
    return
  }
  wake.request()
  if (pendingResume) {
    const prior = pendingResume
    pendingResume = null
    serial(() => processRun(prior))
  }
})
window.addEventListener('pagehide', () => { stopWork(); source?.stop() })

syncSettingsUi()
setState('choose')

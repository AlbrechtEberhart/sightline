import { test, assert } from './harness.js'
test('live-yolo: debug clip runs detection and status', async () => {
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../live/yolo/?source=file&clip=../../tests/fixtures/bus-3s.mp4', import.meta.url); document.body.append(f)
  let s; for (let i = 0; i < 40 && !(s?.lastCount >= 1); i++) { await new Promise(r => setTimeout(r, 500)); s = f.contentWindow.__liveStats }
  f.remove()
  assert(s && s.framesDetected >= 1 && s.framesDetected <= s.framesSeen, JSON.stringify(s))
  assert(s.lastCount >= 1, 'bus clip should yield boxes')
  assert(/^\d+ objects? · (WebGPU|WASM) · \d+ fps$/.test(s.status), s.status)
})
test('live-yolo: recorder sizes from the first frame and stops on a size change', async () => {
  const { Recorder } = await import('../live/yolo/recording.js')
  const frame = (w, h, ts) => { const c = new OffscreenCanvas(w, h); c.getContext('2d').fillRect(0, 0, w, h); return new VideoFrame(c, { timestamp: ts }) }
  const r = new Recorder(); r.arm(30)
  const frames = [frame(640, 480, 0), frame(640, 480, 33000), frame(480, 640, 66000)]
  try {
    assert(await r.addFrame(frames[0], [], 0, true) === 'ok', 'first frame')
    assert(r.ready && r.encoder.width === 640 && r.encoder.height === 480, 'sized from the first frame')
    assert(await r.addFrame(frames[1], [], 0.033, true) === 'ok', 'same size')
    assert(await r.addFrame(frames[2], [], 0.066, true) === 'resized', 'rotated frame is rejected, not stretched')
    const blob = await r.stop()
    assert(blob.type === 'video/mp4' && blob.size > 0, 'clip is finished and non-empty')
  } finally { frames.forEach(f => f.close()); r.abort() }
})
test('live-yolo: tool switch present', async () => {
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../live/yolo/?source=file&clip=../../tests/fixtures/bus-3s.mp4', import.meta.url); document.body.append(f)
  try {
    let nav; for (let i = 0; i < 20 && !nav; i++) { await new Promise(r => setTimeout(r, 250)); nav = f.contentDocument?.querySelector('.tool-switch') }
    assert(nav, '.tool-switch exists')
    assert(nav.querySelector('a[href="../yolo/"][aria-current="page"]'), 'YOLO link is current')
    assert(nav.querySelector('a[href="../panorama/"]'), 'Panorama link')
  } finally { f.remove() }
})

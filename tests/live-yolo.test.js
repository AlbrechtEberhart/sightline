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

import { test, assert, assertEqual, fixture } from './harness.js'
import { listLenses, LiveCameraSource } from '../live/live-camera.js'
const dev = (label, kind = 'videoinput') => ({ deviceId: label || Math.random() + '', label, kind })
test('live-camera: listLenses rear only', async () => {
  const l = await listLenses(async () => [dev('Back Camera'), dev('Back Ultra Wide Camera'), dev('Front Camera'), dev('Mic', 'audioinput')])
  assertEqual(l.map(x => x.label), ['Back Camera', 'Back Ultra Wide Camera'])
})
test('live-camera: listLenses empty labels', async () => {
  const l = await listLenses(async () => [dev(''), dev(''), dev('', 'audioinput')])
  assertEqual(l.map(x => x.label), ['Camera 1', 'Camera 2'])
})
test('live-camera: slow consumer drops frames', async () => {
  const s = await LiveCameraSource.open({ debugFile: await fixture('bus-3s.mp4') }); let n = 0, last = -1
  assertEqual(s.meta.width, 810); const t0 = performance.now()
  for await (const f of s.frames()) {
    assert(f.t > last); last = f.t; f.image.close(); n++
    await new Promise(r => setTimeout(r, 200)); if (performance.now() - t0 > 1000) break
  }
  s.stop(); assert(n >= 3 && n <= 7, `got ${n} frames in 1 s with a 200 ms consumer`)
})
test('live-camera: stop ends generator', async () => {
  const s = await LiveCameraSource.open({ debugFile: await fixture('bus-3s.mp4') }), it = s.frames()
  ;(await it.next()).value.image.close(); s.stop(); assertEqual((await it.next()).done, true)
})

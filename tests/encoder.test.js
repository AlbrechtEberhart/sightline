import { test, assert, assertEqual, assertClose, skip, fixture } from './harness.js'
import { capTo1080, codecCandidates, Mp4Encoder } from '../shared/encoder.js'
import { saveFile } from '../shared/save.js'
import { FileVideoSource } from '../recorded/video-source.js'
const enc = async o => { try { return await Mp4Encoder.create(o) } catch (e) { if (e.name === 'EncoderUnsupportedError') skip('H.264 encoding unavailable in this browser'); throw e } }
const frame = i => { const c = new OffscreenCanvas(320, 240), g = c.getContext('2d'); g.fillStyle = `hsl(${i * 6},80%,50%)`; g.fillRect(0, 0, 320, 240); return c }
const times = async blob => { const s = await FileVideoSource.open(blob), t = []; for await (const f of s.frames()) { t.push(f.t); f.image.close() } return { s, t } }
test('encoder: capTo1080', () => {
  assertEqual(capTo1080(3840, 2160), { width: 1920, height: 1080 }); assertEqual(capTo1080(1080, 1920), { width: 1080, height: 1920 })
  assertEqual(capTo1080(810, 1080), { width: 810, height: 1080 }); assertEqual(capTo1080(4032, 3024), { width: 1440, height: 1080 })
})
test('encoder: 60 frames round trip', async () => {
  const e = await enc({ width: 320, height: 240, fps: 30 })
  for (let i = 0; i < 60; i++) await e.addFrame(frame(i), i / 30)
  const { s, t } = await times(await e.finish())
  assertEqual(t.length, 60); assertClose(s.meta.duration, 2.0, 0.034)
})
test('encoder: VFR timestamps survive round trip', async () => {
  const ts = [0, 0.033, 0.1, 0.5, 0.51], e = await enc({ width: 320, height: 240, fps: 30 })
  for (const [i, t] of ts.entries()) await e.addFrame(frame(i), t)
  const { t } = await times(await e.finish()); t.forEach((v, i) => assertClose(v, ts[i], 0.002))
})
test('encoder: audio passthrough', async () => {
  const src = await FileVideoSource.open(await fixture('bus-3s.mp4')), audio = await src.readAudio()
  const e = await enc({ width: 810, height: 1080, fps: 30, audio })
  for await (const f of src.frames()) { await e.addFrame(f.image, f.t); f.image.close() }
  e.addAudioChunks(audio.chunks)
  const out = await FileVideoSource.open(await e.finish())
  assertEqual(out.meta.hasAudio, true); assertClose(out.meta.duration, 3.0, 0.034)
})
test('encoder: saveFile falls back to download', async () => {
  const calls = []
  assertEqual(await saveFile(new Blob(['x']), 'x.txt', { canShare: () => false }, (url, name) => calls.push(name)), 'downloaded')
  assertEqual(calls, ['x.txt'])
})
test('encoder: saveFile cancelled', async () => {
  const nav = { canShare: () => true, share: async () => { throw new DOMException('no', 'AbortError') } }
  assertEqual(await saveFile(new Blob(['x']), 'x.mp4', nav), 'cancelled')
})
test('encoder: codec candidates by macroblock rate', () => {
  assertEqual(codecCandidates(1920, 1080, 30)[0], 'avc1.640028'); assertEqual(codecCandidates(1920, 1080, 60)[0], 'avc1.64002A')
  assertEqual(codecCandidates(3840, 2160, 30)[0], 'avc1.640033')
})
test('encoder: abort releases and blocks further use', async () => {
  const e = await enc({ width: 320, height: 240, fps: 30 })
  await e.addFrame(frame(0), 0); await e.addFrame(frame(1), 1 / 30)
  e.abort(); e.abort()
  let a = null, b = null
  try { await e.addFrame(frame(2), 2 / 30) } catch (x) { a = x }
  try { await e.finish() } catch (x) { b = x }
  assert(a && b, 'addFrame and finish must reject after abort'); assertEqual(b.message, 'encoder already finished')
})

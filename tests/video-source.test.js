import { test, assert, assertEqual, assertClose, fixture } from './harness.js'
import { FileVideoSource, assertDecodable } from '../recorded/video-source.js'
test('video-source: meta of bus-3s', async () => {
  const s = await FileVideoSource.open(await fixture('bus-3s.mp4'))
  assertEqual([s.meta.width, s.meta.height, s.meta.frameCount, s.meta.hasAudio], [810, 1080, 90, true])
  assertClose(s.meta.duration, 3.0, 0.04); assertClose(s.meta.fps, 30, 0.5)
})
test('video-source: yields 90 ordered frames', async () => {
  const s = await FileVideoSource.open(await fixture('bus-3s.mp4')); let n = 0, last = -1
  for await (const f of s.frames()) { assert(f.t > last); last = f.t; if (n === 0) assertEqual(f.t, 0); assertEqual(f.image.displayWidth, 810); f.image.close(); n++ }
  assertEqual(n, 90)
})
test('video-source: startFrame 45', async () => {
  const s = await FileVideoSource.open(await fixture('bus-3s.mp4')); const idx = []
  for await (const f of s.frames({ startFrame: 45 })) { idx.push(f.index); f.image.close() }
  assertEqual([idx[0], idx.length], [45, 45])
})
test('video-source: rot90 fixture reports display dims', async () => {
  const s = await FileVideoSource.open(await fixture('bus-3s-rot90.mp4'))
  assertEqual([s.meta.width, s.meta.height], [1080, 810])
  for await (const f of s.frames()) { assertEqual([f.image.displayWidth, f.image.displayHeight], [1080, 810]); f.image.close(); break }
})
test('video-source: readAudio null without audio', async () => {
  const s = await FileVideoSource.open(await fixture('bus-3s-noaudio.mp4'))
  assertEqual(s.meta.hasAudio, false); assertEqual(await s.readAudio(), null)
})
test('video-source: readAudio aac', async () => {
  const a = await (await FileVideoSource.open(await fixture('bus-3s.mp4'))).readAudio()
  assertEqual([a.codec, a.sampleRate], ['aac', 44100]); assert(a.chunks.length > 100)
})
test('video-source: garbage rejects VideoOpenError', async () => {
  let e; try { await FileVideoSource.open(new Blob([crypto.getRandomValues(new Uint8Array(4096))])) } catch (x) { e = x }
  assertEqual(e?.name, 'VideoOpenError')
})
test('video-source: unsupported codec', async () => {
  let e; try { await assertDecodable({ codec: 'hvc1.bogus', codedWidth: 64, codedHeight: 64 }) } catch (x) { e = x }
  assertEqual(e?.name, 'UnsupportedCodecError')
})

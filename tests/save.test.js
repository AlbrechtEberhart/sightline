import { test, assert, assertEqual } from './harness.js'
import { canShareFile, shareFile, createSaveControls } from '../shared/save.js'
const blob = () => new Blob(['x'], { type: 'video/mp4' })
const controls = (nav, onError = () => {}) => {
  const share = document.createElement('button'), save = document.createElement('a')
  share.hidden = save.hidden = true
  return { share, save, c: createSaveControls({ share, save, onError, nav }) }
}
test('save: canShareFile asks the browser with a File, and tolerates no Web Share', () => {
  let seen = null
  assertEqual(canShareFile(blob(), 'a.mp4', { canShare: d => { seen = d.files[0]; return true } }), true)
  assert(seen instanceof File && seen.name === 'a.mp4' && seen.type === 'video/mp4', 'shares a named File')
  assertEqual(canShareFile(blob(), 'a.mp4', {}), false)
  assertEqual(canShareFile(blob(), 'a.mp4', { canShare: () => { throw new TypeError('no') } }), false)
})
test('save: shareFile reports cancel and rethrows other failures', async () => {
  assertEqual(await shareFile(blob(), 'a.mp4', { share: async () => {} }), 'shared')
  assertEqual(await shareFile(blob(), 'a.mp4', { share: async () => { throw new DOMException('no', 'AbortError') } }), 'cancelled')
  let err = null
  try { await shareFile(blob(), 'a.mp4', { share: async () => { throw new DOMException('no', 'NotAllowedError') } }) } catch (e) { err = e }
  assertEqual(err?.name, 'NotAllowedError')
})
test('save: offer shows Save file always and Share only when the browser can share files', () => {
  const yes = controls({ canShare: () => true, share: async () => {} })
  yes.c.offer(blob(), 'clip-yolo.mp4')
  assertEqual([yes.share.hidden, yes.save.hidden, yes.save.download], [false, false, 'clip-yolo.mp4'])
  assert(yes.save.href.startsWith('blob:'), 'Save file is a real download link')
  const no = controls({})
  no.c.offer(blob(), 'clip-yolo.mp4')
  assertEqual([no.share.hidden, no.save.hidden], [true, false])
})
test('save: clear hides both and revokes the link', async () => {
  const { share, save, c } = controls({ canShare: () => true })
  c.offer(blob(), 'a.mp4')
  const url = save.href
  c.clear()
  assertEqual([share.hidden, save.hidden, save.hasAttribute('href'), c.ready], [true, true, false, false])
  let revoked = false
  try { await fetch(url) } catch { revoked = true }
  assert(revoked, 'old blob URL is revoked')
})
test('save: Share click shares the offered file; failures go to onError, cancel does not', async () => {
  const shared = [], errors = []
  let fail = null
  const nav = { canShare: () => true, share: async d => { if (fail) throw fail; shared.push(d.files[0].name) } }
  const { share, c } = controls(nav, e => errors.push(e.name))
  share.click() // nothing offered yet: ignored
  c.offer(blob(), 'a.mp4'); share.click()
  fail = new DOMException('no', 'AbortError'); share.click()
  fail = new DOMException('no', 'NotAllowedError'); share.click()
  await new Promise(r => setTimeout(r, 0))
  assertEqual([shared, errors], [['a.mp4'], ['NotAllowedError']])
})

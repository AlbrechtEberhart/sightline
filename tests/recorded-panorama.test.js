import { test, assert, assertEqual, assertClose } from './harness.js'
import { fetchAsset, OPENCV_ASSET } from '../shared/models.js'
import { focalPx } from '../core/stitch/camera-model.js'
import { Stitcher } from '../core/stitch/stitcher.js'
import { FileVideoSource } from '../recorded/video-source.js'
import { scanClip } from '../recorded/panorama/scan.js'
import { panClip } from './fixtures/synthetic-pan.js'

const W = 640, H = 360

async function scan(yaws) {
  const source = await FileVideoSource.open(await panClip({ yaws }))
  const opencvBytes = await fetchAsset(OPENCV_ASSET.url, OPENCV_ASSET)
  const stitcher = await Stitcher.create({ opencvBytes, focalPx: focalPx({ lens: 'wide', width: W, height: H }), width: W, height: H, mode: 'studio' })
  try {
    const res = await scanClip(source, { stitcher })
    return { res, stitcher }
  } catch (err) { stitcher.cancel(); throw err } finally { source.stop() }
}

test('recorded-panorama: synthetic pan clip end to end', async () => {
  const yaws = Array.from({ length: 151 }, (_, i) => i)
  const { res, stitcher } = await scan(yaws)
  try {
    assertEqual(res.error, null)
    assert(res.used.length >= 3 && res.used.length <= 5, `used ${res.used.length} frames`)
    const out = await stitcher.finish()
    assertEqual(out.used, res.used.length)
    out.yaws.forEach((y, i) => assertClose(y - out.yaws[0], yaws[res.used[i]] - yaws[res.used[0]], 0.3))
    out.rolls.forEach(r => assert(Math.abs(r) < 0.5, `roll ${r}`))
    const bmp = await createImageBitmap(out.blob)
    assert(bmp.width > 640, `width ${bmp.width}`)
    bmp.close()
  } catch (err) { stitcher.cancel(); throw err }
})

test('recorded-panorama: static clip is not enough panning', async () => {
  const { res, stitcher } = await scan(new Array(60).fill(0))
  stitcher.cancel()
  assertEqual(res.error, 'Not enough panning')
})

test('recorded-panorama: page reaches result', async () => {
  const clip = await panClip({ yaws: Array.from({ length: 151 }, (_, i) => i) })
  const f = document.createElement('iframe'); f.style.width = '390px'; f.style.height = '844px'
  f.src = new URL('../recorded/panorama/', import.meta.url); document.body.append(f)
  const until = async (fn, tries = 180) => { for (let i = 0; i < tries; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 500)) } return false }
  try {
    assert(await until(() => f.contentWindow.__studioPano?.state === 'choose'), 'choose')
    const doc = f.contentDocument
    const dt = new f.contentWindow.DataTransfer()
    dt.items.add(new f.contentWindow.File([clip], 'pan.mp4', { type: 'video/mp4' }))
    const input = doc.getElementById('file')
    input.files = dt.files
    input.dispatchEvent(new f.contentWindow.Event('change', { bubbles: true }))
    assert(await until(() => f.contentWindow.__studioPano.state === 'ready'), 'ready')
    doc.getElementById('scan').click()
    assert(await until(() => f.contentWindow.__studioPano.state === 'picked'), 'picked')
    assert(f.contentWindow.__studioPano.picked >= 3, 'frames picked')
    doc.getElementById('stitch').click()
    assert(await until(() => f.contentWindow.__studioPano.state === 'result', 180), 'result')
    const img = doc.getElementById('pano-img')
    assert(await until(() => img.complete && img.naturalWidth > 0, 20), 'image decoded')
    assert(img.naturalWidth > 640, `naturalWidth ${img.naturalWidth}`)
    const save = doc.getElementById('save-file')
    assert(!save.hidden && save.download === 'pan-panorama.jpg', 'Save file link')
  } finally { f.remove() }
})

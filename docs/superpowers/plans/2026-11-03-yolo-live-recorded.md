# YOLO (Live + Recorded) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the YOLO tool in both web apps (Live: camera; Recorded: video files), plus all shared modules, both app shells and the launcher.

**Architecture:** Static ES-module site with no build step. Pure engines in `core/detect/` take images and return plain data. Frames reach them through two sources with the same shape: `LiveCameraSource` (camera) and `FileVideoSource` (mp4box.js + WebCodecs). `shared/` holds the model loader, MP4 encoder, saving, drawing and the design system. All tests run on a browser test page served by a PowerShell static server.

**Tech Stack:** Vanilla JS (ES2022 modules), ONNX Runtime Web 1.20.1 (WebGPU → WASM), mp4box.js 0.5.2, mp4-muxer 5.1.3, WebCodecs, Canvas 2D, Web Share API, Cache Storage, Service Worker. Dev tooling: PowerShell 5.1 (`HttpListener`, `System.Drawing`), Colab for the one-off model export.

**Spec:** `docs/superpowers/specs/2026-11-03-live-recorded-yolo-design.md`

## Global Constraints

- No bundler, no build step, no npm. Every page runs as written.
- **No root-absolute URLs** (`/shared/...`). The site is served from a GitHub Pages sub-path. Use relative imports, and `new URL(rel, import.meta.url)` for fetched assets.
- Third-party libraries are vendored in `shared/vendor/`, never loaded from a CDN at runtime. Exact versions go in `shared/vendor/VERSIONS.md`: onnxruntime-web 1.20.1, mp4box 0.5.2, mp4-muxer 5.1.3.
- Deviation from spec 2.5, by decision: there is no import map. Pages import vendored libraries through thin wrappers in `shared/lib/`, which behaves the same at any page depth.
- Model files: `models/yolo11n-320.onnx` and `models/yolo11n-640.onnx`, YOLO11n, fp32, fixed shapes, no NMS in the graph. Output `[1, 84, N]`, where N = 2100 at 320 and 8400 at 640.
- Detection defaults: `conf = 0.35`, `iou = 0.45`. Live input size defaults to 320, Recorded to 640.
- Status line format: `<n> object(s) · <WebGPU|WASM> · <fps> fps`. Footer text exactly: `RESEARCH DEMO · NOT A DRIVING AID`.
- Video output: H.264 MP4, capped at 1080p (long side ≤ 1920, short side ≤ 1080, even dimensions).
- Long-clip warning threshold: duration > 120 s. Live low-fps hint threshold: < 3 fps.
- WASM runs single-threaded (`ort.env.wasm.numThreads = 1`). GitHub Pages cannot send COOP/COEP headers.
- App names: **Sightline Live** (`live/`) and **Sightline Studio** (`recorded/`). Theme: navy background `#0b1220`, mint accent `#5eead4`.
- Every `localStorage` access is wrapped in try/catch, and the app works when storage throws.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Running tests (used by every task):** start the `static` preview (Task 1), navigate the browser pane to `http://localhost:8000/tests/?grep=<pattern>`, and read `window.__testResults` with the browser JavaScript tool once `.done === true`. A test file that fails to import counts as one failed test.

## Review Focus

1. **Portrait iPhone clips.** iPhones store frames sideways and use a rotation flag. Boxes must line up with the upright picture, not the stored one. Pinned by `video-source: rot90 fixture reports display dims` (Task 8).
2. **Clips with no audio track.** Export must still work and produce a silent MP4. Pinned by `readAudio null without audio` (Task 8) and `exportClip without audio` (Task 15).
3. **Variable frame rate.** iPhone clips are VFR, so output timing must follow the source timestamps, not frame index ÷ fps. Pinned by `encoder: VFR timestamps survive round trip` (Task 9).
4. **Cancelling mid-processing, then re-running.** Cancelling must stop decoding, close frames and leave the app able to start again. Pinned by `processClip cancel stops early` (Task 14).
5. **Cameras with empty labels before permission is granted** (Safari/Brave). The lens picker must still offer choices. Pinned by `listLenses empty labels` (Task 11).

---

### Task 1: Dev server and test harness

**Files:**
- Create: `tools/serve.ps1`, `.claude/launch.json`, `tests/harness.js`, `tests/index.html`, `tests/manifest.js`, `tests/harness.test.js`, `.nojekyll`

**Interfaces:**
- Produces:
  - `tools/serve.ps1 -Port 8000`: serves the repo root on `http://localhost:8000/`.
  - `tests/harness.js` exports `test(name, fn)`, `assert(cond, msg)`, `assertEqual(actual, expected, msg)` (deep, via structural compare), `assertClose(actual, expected, tol, msg)`, `skip(reason)` (throws a `SkipError`), `fixture(name) → Promise<Blob>` (fetches `tests/fixtures/<name>`), `fixtureImage(name) → Promise<ImageBitmap>`, and `run({ grep }) → Promise<Results>`.
  - `Results = { done, passed, failed, skipped, results: [{ name, status: 'pass'|'fail'|'skip', message }] }`, mirrored to `window.__testResults`.
  - `tests/manifest.js` exports a default array of test file names. Each later task appends its own file.

- [ ] **Step 1: Write `tools/serve.ps1`.** Use `System.Net.HttpListener` on `http://localhost:$Port/`, serving files under the repo root. It must:
  - set the MIME types: `.html text/html`, `.js/.mjs text/javascript`, `.css text/css`, `.json application/json`, `.webmanifest application/manifest+json`, `.wasm application/wasm`, `.onnx application/octet-stream`, `.mp4 video/mp4`, `.png image/png`, `.jpg image/jpeg`, `.svg image/svg+xml`;
  - map `/` and directory paths to `index.html`;
  - send `Cache-Control: no-store`;
  - answer single-range `Range: bytes=a-b` requests with 206 (`<video>` seeking needs it);
  - return 404 for missing files and refuse paths that resolve outside the root;
  - handle each request in a try/catch so one failure doesn't kill the server.
- [ ] **Step 2: Add `.claude/launch.json`** with one configuration: `{"name":"static","runtimeExecutable":"powershell","runtimeArgs":["-NoProfile","-ExecutionPolicy","Bypass","-File","tools/serve.ps1","-Port","8000"],"port":8000}`.
- [ ] **Step 3: Write `tests/harness.test.js`**

```js
import { test, assert, assertEqual, assertClose, skip } from './harness.js'
test('harness: assertEqual deep', () => assertEqual({ a: [1, 2] }, { a: [1, 2] }))
test('harness: assertClose', () => assertClose(0.1 + 0.2, 0.3, 1e-9))
test('harness: assert throws on false', () => {
  let threw = false; try { assert(false, 'x') } catch { threw = true }
  assert(threw, 'assert(false) must throw')
})
test('harness: skip marks skipped', () => skip('demo'))
```

- [ ] **Step 4: Implement `tests/harness.js`, `tests/index.html` and `tests/manifest.js`** (manifest contents: `['harness.test.js']`). The page dynamically imports every manifest file (recording an import error as a failed test named after the file), runs the tests whose name *or test file name* contains `?grep=`, gives each test a 60 s timeout, renders a pass/fail list and sets `window.__testResults`.
- [ ] **Step 5: Run tests** `?grep=harness`. Expected: `passed: 3, failed: 0, skipped: 1`.
- [ ] **Step 6: Commit** `git add tools .claude/launch.json tests .nojekyll` then `git commit -m "chore: add static dev server and browser test harness"`.

---

### Task 2: Model export notebook and fixtures (the user runs it on Colab)

**Files:**
- Create: `tools/export_yolo.ipynb`, `models/README.md`
- Produced by the user's Colab run: `models/yolo11n-320.onnx`, `models/yolo11n-640.onnx`, `tests/fixtures/bus.jpg`, `tests/fixtures/bus-3s.mp4`, `tests/fixtures/bus-3s-noaudio.mp4`, `tests/fixtures/bus-3s-rot90.mp4`

**Interfaces:**
- Produces the files above. Tasks 6, 7, 8, 9, 11, 13, 14 and 15 depend on them. Tasks 3–5 and 10 do not, so continue with those while waiting.

- [ ] **Step 1: Write the notebook.** Its cells:
  1. `pip install ultralytics==8.3.40 onnx`
  2. For `imgsz` in (320, 640): `YOLO('yolo11n.pt').export(format='onnx', imgsz=imgsz, opset=17, simplify=True, dynamic=False, nms=False)`, then rename the output to `yolo11n-<imgsz>.onnx`.
  3. Assert each model's output shape with `onnx`: `[1, 84, 2100]` for 320 and `[1, 84, 8400]` for 640.
  4. Download `https://ultralytics.com/images/bus.jpg`.
  5. Make the clips with ffmpeg:
     - `ffmpeg -y -loop 1 -i bus.jpg -f lavfi -i sine=frequency=440:sample_rate=44100 -t 3 -r 30 -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 96k -shortest bus-3s.mp4`
     - the same command without the sine input and with `-an` → `bus-3s-noaudio.mp4`
     - `ffmpeg -y -i bus-3s.mp4 -c copy -metadata:s:v:0 rotate=90 bus-3s-rot90.mp4`
  6. Assert with `ffprobe -count_frames` that each clip has 90 frames.
  7. Zip everything and call `files.download`.
- [ ] **Step 2: Write `models/README.md`** (how to regenerate the files, plus the AGPL-3.0 note from spec 3.1). Commit with `git commit -m "chore: add Colab notebook for YOLO11n ONNX export and test fixtures"`.
- [ ] **Step 3: Ask the user** to run the notebook on Colab and put the zip's contents into `models/` and `tests/fixtures/`. Wait for confirmation.
- [ ] **Step 4: Verify.** Run `Get-ChildItem models/*.onnx, tests/fixtures/* | Select Name, Length`. Expected: six files, each `.onnx` between 9 MB and 12 MB.
- [ ] **Step 5: Commit** `git add models tests/fixtures` then `git commit -m "chore: add exported YOLO11n models and video fixtures"`.

---

### Task 3: Vendored libraries

**Files:**
- Create: `shared/vendor/ort/*`, `shared/vendor/mp4box.mjs`, `shared/vendor/mp4-muxer.mjs`, `shared/vendor/VERSIONS.md`, `shared/lib/ort.js`, `shared/lib/mp4box.js`, `shared/lib/mp4-muxer.js`
- Test: `tests/vendor.test.js`

**Interfaces:**
- Produces:
  - `shared/lib/ort.js`: `export { ort }`, configured with `ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href` and `ort.env.wasm.numThreads = 1`.
  - `shared/lib/mp4box.js`: `export default MP4Box`, exposing `createFile()` and `DataStream`.
  - `shared/lib/mp4-muxer.js`: `export { Muxer, ArrayBufferTarget }`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert } from './harness.js'
test('vendor: ort loads', async () => {
  const { ort } = await import('../shared/lib/ort.js')
  assert(typeof ort.InferenceSession.create === 'function')
  assert(ort.env.wasm.numThreads === 1)
})
test('vendor: mp4box loads', async () => {
  const MP4Box = (await import('../shared/lib/mp4box.js')).default
  assert(typeof MP4Box.createFile === 'function')
})
test('vendor: mp4-muxer loads', async () => {
  const m = await import('../shared/lib/mp4-muxer.js')
  assert(typeof m.Muxer === 'function' && typeof m.ArrayBufferTarget === 'function')
})
```

- [ ] **Step 2: Run tests** `?grep=vendor`. Expected: FAIL (imports not found).
- [ ] **Step 3: Download the libraries.** These are dependency downloads, so confirm the file list with the user before fetching.
  - ORT: list the files with `https://data.jsdelivr.com/v1/packages/npm/onnxruntime-web@1.20.1`. Vendor the WebGPU ESM build from `dist/` (`ort.webgpu.min.mjs`, or the `.bundle.` variant if that's how 1.20.1 ships it) plus the `ort-wasm-simd-threaded.jsep.mjs` / `.wasm` files it loads.
  - mp4box: `https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm`, saved as `mp4box.mjs`.
  - mp4-muxer: `https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs`.
  - Record each URL, version and SHA-256 in `VERSIONS.md`.
  - If a `+esm` file imports other jsDelivr URLs, vendor those too and rewrite the imports to relative paths.
- [ ] **Step 4: Write the three `shared/lib/` wrappers** to the interfaces above.
- [ ] **Step 5: Run tests** `?grep=vendor`. Expected: `passed: 3, failed: 0`. Check the browser pane's network log: no requests to any CDN.
- [ ] **Step 6: Commit** `git add shared/vendor shared/lib tests/vendor.test.js tests/manifest.js` then `git commit -m "chore: vendor onnxruntime-web, mp4box and mp4-muxer"`.

---

### Task 4: Letterbox geometry

**Files:**
- Create: `core/detect/letterbox.js`
- Test: `tests/letterbox.test.js`

**Interfaces:**
- Produces:
  - `letterbox(srcW, srcH, size) → { scale, newW, newH, padX, padY }`, where `scale = min(size/srcW, size/srcH)`, `newW = round(srcW*scale)`, `newH = round(srcH*scale)`, `padX = floor((size-newW)/2)` and `padY = floor((size-newH)/2)`.
  - `toInput([x,y,w,h], lb) → [x,y,w,h]`
  - `toSource([x,y,w,h], lb, srcW, srcH) → [x,y,w,h]`, clamped to the source bounds.

- [ ] **Step 1: Write the failing test**

```js
import { test, assertEqual, assertClose } from './harness.js'
import { letterbox, toInput, toSource } from '../core/detect/letterbox.js'
const near = (a, b) => a.forEach((v, i) => assertClose(v, b[i], 0.5))
test('letterbox: landscape 1920x1080 @640', () => {
  const lb = letterbox(1920, 1080, 640)
  assertClose(lb.scale, 1 / 3, 1e-9); assertEqual([lb.newW, lb.newH, lb.padX, lb.padY], [640, 360, 0, 140])
})
test('letterbox: portrait 1080x1920 @320', () => {
  const lb = letterbox(1080, 1920, 320)
  assertEqual([lb.newW, lb.newH, lb.padX, lb.padY], [180, 320, 70, 0])
})
test('letterbox: square 1000x1000 @640', () => {
  const lb = letterbox(1000, 1000, 640); assertEqual([lb.padX, lb.padY], [0, 0])
})
test('letterbox: round trip within 0.5px', () => {
  for (const [w, h, s] of [[1920, 1080, 640], [1080, 1920, 320], [1000, 1000, 640]]) {
    const lb = letterbox(w, h, s), box = [100, 200, 300, 400]
    near(toSource(toInput(box, lb), lb, w, h), box)
  }
})
test('letterbox: toSource clamps to image', () => {
  const lb = letterbox(1920, 1080, 640)
  assertEqual(toSource([-10, 130, 700, 100], lb, 1920, 1080)[0], 0)
})
```

- [ ] **Step 2: Run tests** `?grep=letterbox`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `core/detect/letterbox.js`** to the interface.
- [ ] **Step 4: Run tests** `?grep=letterbox`. Expected: `passed: 5, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(detect): letterbox geometry"` (add the code, the test and `tests/manifest.js`).

---

### Task 5: Output decoding, NMS, labels and colours

**Files:**
- Create: `core/detect/decode.js`, `core/detect/nms.js`, `core/detect/labels.js`, `core/detect/colors.js`, `tests/fixtures/yolo-output.js`
- Test: `tests/decode.test.js`

**Interfaces:**
- Produces:
  - `decode(data: Float32Array, n: number, conf: number) → Array<{ classId, score, box: [x,y,w,h] }>`. Channel-major layout: `data[c*n + i]`. Channels 0–3 are cx, cy, w, h in input pixels and channels 4–83 are class scores. Each candidate keeps only its top class, and only if that score ≥ `conf`. The output box is top-left based.
  - `iouOf(a, b) → number`
  - `nms(boxes, iou) → boxes`: per-class, sorted by score descending.
  - `COCO_LABELS`: the 80 standard COCO names in Ultralytics order (`'person'`, `'bicycle'`, `'car'`, …, `'toothbrush'`).
  - `colorFor(classId) → '#rrggbb'`: fixed, from a 20-colour palette chosen to read well on `#0b1220`, indexed by `classId % 20`.
  - The test fixture `makeOutput(n, candidates: Array<{cx,cy,w,h,scores:{[classId]:score}}>) → Float32Array`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual, assertClose } from './harness.js'
import { decode } from '../core/detect/decode.js'
import { nms, iouOf } from '../core/detect/nms.js'
import { COCO_LABELS } from '../core/detect/labels.js'
import { colorFor } from '../core/detect/colors.js'
import { makeOutput } from './fixtures/yolo-output.js'
test('decode: keeps top class above conf', () => {
  const out = makeOutput(4, [
    { cx: 100, cy: 100, w: 50, h: 20, scores: { 2: 0.9 } },
    { cx: 10, cy: 10, w: 5, h: 5, scores: { 0: 0.2 } },
    { cx: 200, cy: 200, w: 40, h: 40, scores: { 5: 0.5, 7: 0.6 } },
    { cx: 0, cy: 0, w: 0, h: 0, scores: {} }])
  const r = decode(out, 4, 0.35)
  assertEqual(r.map(b => b.classId), [2, 7]); assertEqual(r[0].box, [75, 90, 50, 20]); assertClose(r[1].score, 0.6, 1e-6)
})
test('nms: iouOf', () => {
  assertClose(iouOf([0, 0, 100, 100], [0, 0, 100, 100]), 1, 1e-9)
  assertEqual(iouOf([0, 0, 10, 10], [20, 20, 10, 10]), 0)
  assertClose(iouOf([0, 0, 100, 100], [10, 10, 100, 100]), 8100 / 11900, 1e-6)
})
const b = (classId, score, box) => ({ classId, score, box })
test('nms: same class overlap suppressed', () =>
  assertEqual(nms([b(2, .8, [10, 10, 100, 100]), b(2, .9, [0, 0, 100, 100])], 0.45).map(x => x.score), [.9]))
test('nms: different classes kept', () =>
  assertEqual(nms([b(2, .9, [0, 0, 100, 100]), b(5, .8, [10, 10, 100, 100])], 0.45).length, 2))
test('nms: empty input', () => assertEqual(nms([], 0.45), []))
test('labels: 80 COCO names', () => {
  assertEqual(COCO_LABELS.length, 80); assertEqual([COCO_LABELS[0], COCO_LABELS[2], COCO_LABELS[5], COCO_LABELS[9]], ['person', 'car', 'bus', 'traffic light'])
})
test('colors: stable and distinct', () => {
  assertEqual(colorFor(2), colorFor(2)); assert(colorFor(0) !== colorFor(2)); assert(/^#[0-9a-f]{6}$/.test(colorFor(79)))
})
```

- [ ] **Step 2: Run tests** `?grep=decode` (matches the whole `decode.test.js` file). Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the four modules and the fixture to the interfaces.
- [ ] **Step 4: Run tests** `?grep=decode`. Expected: `passed: 7, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(detect): YOLO output decoding, NMS, labels, colours"`.

---

### Task 6: Model loading (`shared/models.js`)

**Files:**
- Create: `shared/models.js`
- Test: `tests/models.test.js`

**Interfaces:**
- Consumes: `ort` from `shared/lib/ort.js`.
- Produces:
  - `fetchModel(url, onProgress?: (loaded, total) => void) → Promise<Uint8Array>`. Cache-first through Cache Storage, cache name `cv-models-v1`. If `caches` is missing or throws, it goes straight to the network. A non-OK response rejects with an `Error` whose `name === 'ModelDownloadError'`, and nothing is cached.
  - `createSession(bytes, { backend: 'auto'|'webgpu'|'wasm' }) → Promise<{ session, backend: 'webgpu'|'wasm' }>`. `'auto'` tries `executionProviders: ['webgpu']` and falls back to `['wasm']` on any error or when `navigator.gpu` is missing.
  - `MODEL_URLS = { 320: URL, 640: URL }`, resolved from `../models/` relative to `import.meta.url`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual } from './harness.js'
import { fetchModel, createSession, MODEL_URLS } from '../shared/models.js'
test('models: fetch caches', async () => {
  await caches.delete('cv-models-v1')
  const a = await fetchModel(MODEL_URLS[320])
  assert(a.byteLength > 9e6)
  assert(await (await caches.open('cv-models-v1')).match(MODEL_URLS[320].href))
})
test('models: missing file rejects ModelDownloadError', async () => {
  let err; try { await fetchModel(new URL('../models/missing.onnx', location.href)) } catch (e) { err = e }
  assertEqual(err?.name, 'ModelDownloadError')
})
test('models: wasm session', async () => {
  const { session, backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'wasm' })
  assertEqual(backend, 'wasm'); assertEqual(session.inputNames.length, 1)
})
test('models: auto picks a backend', async () => {
  const { backend } = await createSession(await fetchModel(MODEL_URLS[320]), { backend: 'auto' })
  assert(backend === 'webgpu' || backend === 'wasm')
})
```

- [ ] **Step 2: Run tests** `?grep=models`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/models.js`** to the interface. Progress comes from reading the response body stream and comparing against `Content-Length`.
- [ ] **Step 4: Run tests** `?grep=models`. Expected: `passed: 4, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(shared): model download cache and ORT session with WebGPU fallback"`.

---

### Task 7: Detector (`core/detect/detector.js`)

**Files:**
- Create: `core/detect/detector.js`
- Test: `tests/detector.test.js`

**Interfaces:**
- Consumes: `letterbox` and `toSource` (Task 4), `decode`, `nms`, `COCO_LABELS` (Task 5), `createSession` (Task 6).
- Produces:
  - `preprocess(image, size) → { data: Float32Array, lb }`. Draws onto an `OffscreenCanvas(size, size)` filled with `rgb(114,114,114)`, places the image letterboxed, and returns RGB in CHW order scaled to 0–1. `image` is any `CanvasImageSource`; its size is `image.displayWidth ?? image.width` × `image.displayHeight ?? image.height`.
  - `createDetector({ modelBytes, inputSize, backend = 'auto' }) → Promise<Detector>`
  - `Detector = { backend, inputSize, warmupMs, detect(image, { conf = 0.35, iou = 0.45 } = {}) → Promise<Box[]>, dispose() }`
  - `Box = { classId, label, score, box: [x,y,w,h] }`, in source pixels.
  - `warmupMs` is the mean time of 3 warm-up runs on a blank input.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual, assertClose, fixtureImage } from './harness.js'
import { preprocess, createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
test('detector: preprocess pads grey, CHW RGB', () => {
  const c = new OffscreenCanvas(4, 2), g = c.getContext('2d')
  g.fillStyle = '#f00'; g.fillRect(0, 0, 2, 2); g.fillStyle = '#00f'; g.fillRect(2, 0, 2, 2)
  const { data, lb } = preprocess(c, 4), px = (ch, y, x) => data[ch * 16 + y * 4 + x]
  assertEqual(lb.padY, 1); assertClose(px(1, 0, 0), 114 / 255, 1e-3)
  assertClose(px(0, 1, 0), 1, 1e-3); assertClose(px(2, 1, 3), 1, 1e-3); assertClose(px(0, 1, 3), 0, 1e-3)
})
test('detector: bus.jpg @640 finds bus and person', async () => {
  const det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[640]), inputSize: 640 })
  const boxes = await det.detect(await fixtureImage('bus.jpg'))
  assert(boxes.some(b => b.label === 'bus' && b.score > 0.5), 'bus')
  assert(boxes.some(b => b.label === 'person' && b.score > 0.5), 'person')
  assert(det.warmupMs > 0); det.dispose()
})
test('detector: 320 model runs', async () => {
  const det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
  assert(Array.isArray(await det.detect(await fixtureImage('bus.jpg')))); det.dispose()
})
```

- [ ] **Step 2: Run tests** `?grep=detector`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `core/detect/detector.js`.** Set `imageSmoothingQuality = 'high'` when resizing. Read the model output from `session.outputNames[0]`, with `n = output.dims[2]`.
- [ ] **Step 4: Run tests** `?grep=detector`. Expected: `passed: 3, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(detect): YOLO detector with preprocessing and warm-up"`.

---

### Task 8: `FileVideoSource` (`recorded/video-source.js`)

**Files:**
- Create: `recorded/video-source.js`, `shared/frame-source.js` (JSDoc `@typedef`s only: `Frame = { image, t, index?, motion? }` and `FrameSource = { meta, frames(), stop() }`, plus the spec 2.2 contract that the consumer closes `image`; both sources reference it)
- Test: `tests/video-source.test.js`

**Interfaces:**
- Consumes: `MP4Box` (Task 3).
- Produces:
  - `FileVideoSource.open(blob) → Promise<FileVideoSource>`. If the file can't be parsed, it rejects with `name === 'VideoOpenError'`. If `VideoDecoder.isConfigSupported` says no, it rejects with `name === 'UnsupportedCodecError'`, message `Can't decode this video. On iPhone set Camera → Formats → Most Compatible.`
  - `assertDecodable(config) → Promise<void>`, exported so the codec check can be tested on its own.
  - `meta = { width, height, fps, duration, frameCount, rotation: 0|90|180|270, codec, hasAudio, live: false }`. `width` and `height` are the upright (after rotation) size. `fps = frameCount / duration`.
  - `frames({ startFrame = 0 } = {}) → AsyncGenerator<{ image: VideoFrame, t, index }>`. Frames come in presentation order, upright: when `rotation ≠ 0`, each frame is drawn rotated onto an `OffscreenCanvas` and re-wrapped as a `VideoFrame`. `t` is in seconds from the first frame. With `startFrame`, decoding starts at the nearest keyframe at or before that frame and earlier frames are closed without being yielded. The consumer closes every yielded frame.
  - `readAudio() → Promise<null | { codec: 'aac', sampleRate, numberOfChannels, description: Uint8Array, chunks: Array<{ data: Uint8Array, timestamp, duration }> }>`, with timestamp and duration in microseconds.
  - `stop()`: ends any running generator and closes the decoder.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run tests** `?grep=video-source`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `recorded/video-source.js`.**
  - Read the blob in 1 MB slices into `mp4box.appendBuffer` (setting `fileStart`), then `flush()`.
  - Build `description` from the `avcC`/`hvcC` box with `DataStream`, skipping the 8-byte box header.
  - Take rotation from the track matrix.
  - Apply backpressure by pausing extraction while `decoder.decodeQueueSize > 8`.
- [ ] **Step 4: Run tests** `?grep=video-source`. Expected: `passed: 8, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(recorded): FileVideoSource with WebCodecs decoding, rotation and audio read"`.

---

### Task 9: MP4 encoder and saving (`shared/encoder.js`, `shared/save.js`)

**Files:**
- Create: `shared/encoder.js`, `shared/save.js`
- Test: `tests/encoder.test.js`

**Interfaces:**
- Consumes: `Muxer` and `ArrayBufferTarget` (Task 3), `FileVideoSource` (Task 8, test only).
- Produces:
  - `capTo1080(w, h) → { width, height }`: scales down only, so the long side is ≤ 1920 and the short side ≤ 1080, rounded down to even numbers.
  - `Mp4Encoder.create({ width, height, fps, audio? }) → Promise<Mp4Encoder>`. `audio` has the same shape as `readAudio()`'s return value, minus `chunks`. Video is H.264, trying `avc1.640028` and then `avc1.42E028`. Bitrate is `width*height*fps*0.1` bits per second. A keyframe is forced every 2 s of `t`. The muxer uses `fastStart: 'in-memory'` and `firstTimestampBehavior: 'offset'`. If no codec is supported, it rejects with `name === 'EncoderUnsupportedError'`.
  - `encoder.addFrame(image, t) → Promise<void>`: `t` is in seconds; awaits while `encodeQueueSize > 4`.
  - `encoder.addAudioChunks(chunks)`: passes chunks through to `addAudioChunkRaw`.
  - `encoder.finish() → Promise<Blob>` (`video/mp4`).
  - `saveFile(blob, filename, nav = navigator) → Promise<'shared'|'downloaded'|'cancelled'>`. Uses the share sheet when `nav.canShare?.({ files })` is true; an `AbortError` returns `'cancelled'`. Otherwise it clicks a temporary `<a download>`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual, assertClose, skip, fixture } from './harness.js'
import { capTo1080, Mp4Encoder } from '../shared/encoder.js'
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
  assertEqual(await saveFile(new Blob(['x']), 'x.txt', { canShare: () => false }), 'downloaded')
})
test('encoder: saveFile cancelled', async () => {
  const nav = { canShare: () => true, share: async () => { throw new DOMException('no', 'AbortError') } }
  assertEqual(await saveFile(new Blob(['x']), 'x.mp4', nav), 'cancelled')
})
```

- [ ] **Step 2: Run tests** `?grep=encoder`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/encoder.js` and `shared/save.js`** to the interfaces.
- [ ] **Step 4: Run tests** `?grep=encoder`. Expected: `passed: 6, failed: 0`. If the four encode tests report `skipped` (the browser pane has no H.264 encoder), record that in the task report. Those tests then have to pass in Safari on the iPhone (Task 16's checklist).
- [ ] **Step 5: Commit** `git commit -m "feat(shared): WebCodecs MP4 encoder with audio passthrough, and saveFile"`.

---

### Task 10: Design system, launcher, manifests, icons and service worker

**Files:**
- Create: `shared/ui.css`, `shared/ui.js`, `index.html`, `sw.js`, `shared/register-sw.js`, `tools/make-icons.ps1`, `live/manifest.webmanifest`, `recorded/manifest.webmanifest`, `live/icons/icon-{180,192,512}.png`, `recorded/icons/icon-{180,192,512}.png`
- Test: `tests/ui.test.js`

**Interfaces:**
- Produces:
  - **`ui.css` classes:** `.app` (grid: `left | viewport | right` in landscape; the side panels become `.sheet` below the viewport in portrait, using `@media (orientation: portrait)`), `.topbar`, `.status` (monospace), `.footer-disclaimer`, `.pill`, `.pill.active`, `.section-title` (uppercase, letter-spaced), `.progress > .bar`, `.sheet`, `.error-card`.
  - **`ui.css` tokens on `:root`:** `--bg: #0b1220`, `--panel: #111a2e`, `--text: #e5edf7`, `--muted: #8da2c0`, `--accent: #5eead4`, `--danger: #f87171`. Apply `env(safe-area-inset-*)` padding.
  - **`ui.js`:**
    - `showError(container, { title, body, actions: [{ label, onClick }] })` renders an `.error-card`.
    - `formatEta(seconds) → string` gives `'45 s'` below 60 s, otherwise `'3 min 05 s'`.
    - `loadSettings(key, defaults) → object` and `saveSettings(key, obj)` wrap `localStorage` in try/catch.
  - **`sw.js` at the repo root:** stale-while-revalidate for same-origin GETs in cache `cv-shell-v1`, except `.onnx` (handled by `models.js`) and requests with a `Range` header.
  - **`register-sw.js`:** registers `../sw.js` relative to itself, except on `localhost` unless `?sw=1` is set.
  - **Manifests:** `name` / `short_name` = `Sightline Live` / `SL Live` and `Sightline Studio` / `SL Studio`, with `start_url: "./"`, `scope: "./"`, `display: "standalone"`, `background_color` / `theme_color` `#0b1220`, and the three icons.
  - **Launcher `index.html`:** two large cards linking to `live/yolo/` and `recorded/yolo/`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assertEqual } from './harness.js'
import { formatEta, loadSettings, saveSettings } from '../shared/ui.js'
test('ui: formatEta', () => { assertEqual(formatEta(45), '45 s'); assertEqual(formatEta(185), '3 min 05 s') })
test('ui: settings survive storage failure', () => {
  const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') }, configurable: true })
  try { saveSettings('k', { a: 1 }); assertEqual(loadSettings('k', { a: 2 }), { a: 2 }) }
  finally { Object.defineProperty(window, 'localStorage', orig) }
})
test('ui: manifests valid', async () => {
  for (const [p, name] of [['../live/manifest.webmanifest', 'Sightline Live'], ['../recorded/manifest.webmanifest', 'Sightline Studio']]) {
    const m = await (await fetch(new URL(p, import.meta.url))).json()
    assertEqual([m.name, m.display, m.icons.length], [name, 'standalone', 3])
  }
})
```

- [ ] **Step 2: Run tests** `?grep=ui:`. Expected: FAIL.
- [ ] **Step 3: Write `tools/make-icons.ps1`** and run it. It uses `System.Drawing` to draw a navy square with a mint rounded-square outline and a centred glyph ("L" for Live, "S" for Studio) at 180, 192 and 512 px.
- [ ] **Step 4: Implement** `ui.css`, `ui.js`, `index.html`, both manifests, `sw.js` and `register-sw.js`. Each app page later adds `<link rel="manifest">`, `<link rel="apple-touch-icon" href="../icons/icon-180.png">`, `<meta name="apple-mobile-web-app-capable" content="yes">` and `<meta name="apple-mobile-web-app-title">`.
- [ ] **Step 5: Run tests** `?grep=ui:`. Expected: `passed: 3, failed: 0`. Then open `http://localhost:8000/`, take a screenshot and check that both cards are visible on the dark theme.
- [ ] **Step 6: Commit** `git commit -m "feat(shared): design system, launcher, manifests, icons, service worker"`.

---

### Task 11: `LiveCameraSource` (`live/live-camera.js`)

**Files:**
- Create: `live/live-camera.js`
- Test: `tests/live-camera.test.js`

**Interfaces:**
- Produces:
  - `listLenses(enumerate = () => navigator.mediaDevices.enumerateDevices()) → Promise<Array<{ deviceId, label }>>`. Returns `videoinput` devices whose label matches `/back|rear|environment/i`. If every label is empty, it returns all `videoinput` devices labelled `Camera 1`, `Camera 2`, …
  - `LiveCameraSource.open({ deviceId?, debugFile? }) → Promise<LiveCameraSource>`.
    - Without `debugFile`: `getUserMedia({ audio: false, video: { deviceId: deviceId ? { exact: deviceId } : undefined, facingMode: deviceId ? undefined : 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } })`. A `NotAllowedError` is rethrown as `name === 'CameraPermissionError'`.
    - With `debugFile`: plays the blob in a looping, muted video.
    - Both paths feed one `<video playsinline muted>`, exposed as `source.video` for the preview.
  - `meta = { width, height, fps, live: true }`
  - `frames() → AsyncGenerator<{ image: VideoFrame, t, motion: undefined }>`. Each `next()` waits for the next `requestVideoFrameCallback`, then wraps the *current* video frame. Frames that arrive while the consumer is busy are therefore never queued. `t` is in seconds since `open`.
  - `stop()`: stops tracks, revokes object URLs, ends the generator.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run tests** `?grep=live-camera`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `live/live-camera.js`** to the interface. `meta.fps` comes from `track.getSettings().frameRate`, or 30 in debug mode.
- [ ] **Step 4: Run tests** `?grep=live-camera`. Expected: `passed: 4, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(live): LiveCameraSource with newest-frame semantics and lens list"`.

---

### Task 12: Drawing and status helpers

**Files:**
- Create: `shared/draw-boxes.js`, `live/yolo/status.js`
- Test: `tests/draw.test.js`

**Interfaces:**
- Consumes: `colorFor` (Task 5), the `Box` type (Task 7).
- Produces:
  - `fitCover(srcW, srcH, dstW, dstH) → { scale, offsetX, offsetY }` (matches CSS `object-fit: cover`) and `fitContain(...)` with the same shape (matches `contain`).
  - `drawDetections(ctx, boxes, { scale = 1, offsetX = 0, offsetY = 0, showLabels = true, dpr = 1 })`. Each box gets a 2·dpr px stroke in `colorFor(classId)` with corner radius 4·dpr, and a filled tag `"<label> <round(score*100)>%"` above the box (inside it when the box touches the top edge).
  - `createFpsMeter(windowSec = 1) → { tick(nowMs), fps }`: `fps` counts ticks in the trailing window.
  - `formatStatus({ count, backend, fps }) → string`, e.g. `'5 objects · WebGPU · 11 fps'` or `'1 object · WASM · 3 fps'`. `backend` is `'webgpu'` or `'wasm'`; fps is rounded.
  - `lowFpsHint(fps, recording) → string | null`. Below 3 fps it returns `'Low frame rate. Stop recording to speed up.'` when recording, otherwise `'Low frame rate. Try the Ultra Wide lens or input size 320.'`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual, assertClose } from './harness.js'
import { fitCover, fitContain, drawDetections } from '../shared/draw-boxes.js'
import { createFpsMeter, formatStatus, lowFpsHint } from '../live/yolo/status.js'
import { colorFor } from '../core/detect/colors.js'
test('draw: fitCover portrait clip on phone', () => {
  const f = fitCover(810, 1080, 390, 844); assertClose(f.scale, 844 / 1080, 1e-9); assertClose(f.offsetX, (390 - 810 * 844 / 1080) / 2, 1e-6); assertEqual(f.offsetY, 0)
})
test('draw: fitContain', () => { const f = fitContain(1920, 1080, 960, 1080); assertClose(f.scale, 0.5, 1e-9); assertEqual(f.offsetX, 0); assertClose(f.offsetY, 270, 1e-6) })
test('draw: stroke uses class colour', () => {
  const c = new OffscreenCanvas(100, 100), g = c.getContext('2d')
  drawDetections(g, [{ classId: 2, label: 'car', score: 0.86, box: [20, 40, 60, 40] }], { showLabels: false })
  const [r, gg, b] = g.getImageData(50, 40, 1, 1).data, hex = '#' + [r, gg, b].map(v => v.toString(16).padStart(2, '0')).join('')
  assertEqual(hex, colorFor(2))
})
test('draw: fps meter', () => { const m = createFpsMeter(); for (let i = 0; i <= 10; i++) m.tick(i * 100); assertEqual(Math.round(m.fps), 10) })
test('draw: formatStatus', () => {
  assertEqual(formatStatus({ count: 5, backend: 'webgpu', fps: 11.4 }), '5 objects · WebGPU · 11 fps')
  assertEqual(formatStatus({ count: 1, backend: 'wasm', fps: 3 }), '1 object · WASM · 3 fps')
})
test('draw: lowFpsHint', () => { assertEqual(lowFpsHint(5, false), null); assert(lowFpsHint(2, true).includes('Stop recording')) })
```

- [ ] **Step 2: Run tests** `?grep=draw`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules to the interfaces.
- [ ] **Step 4: Run tests** `?grep=draw`. Expected: `passed: 6, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(shared): box drawing, fit helpers, fps meter and status text"`.

---

### Task 13: Live YOLO app (`live/yolo/`)

**Files:**
- Create: `live/yolo/index.html`, `live/yolo/app.js`
- Test: `tests/live-yolo.test.js`

**Interfaces:**
- Consumes: `LiveCameraSource` and `listLenses` (Task 11), `createDetector` (Task 7), `fetchModel` and `MODEL_URLS` (Task 6), `drawDetections` and `fitCover` (Task 12), `createFpsMeter`, `formatStatus` and `lowFpsHint` (Task 12), `Mp4Encoder` and `capTo1080` (Task 9), `saveFile` (Task 9), `showError`, `loadSettings` and `saveSettings` (Task 10).
- Produces:
  - **Page:** a `.topbar` (title `Sightline Live`, lens `<select>`, record pill, settings pill), a full-screen `<video>` with `object-fit: cover` under an overlay `<canvas>`, a `.status` line, the `.footer-disclaimer`, and a settings `.sheet` (conf slider 0.1–0.9, input size 320/640, labels toggle). Settings persist under the key `live-yolo-settings` with defaults `{ conf: 0.35, inputSize: 320, showLabels: true }`.
  - **Debug query:** `?source=file&clip=<relative url>` opens `LiveCameraSource` with `debugFile` set to the fetched clip.
  - **Test hook:** `window.__liveStats = { framesSeen, framesDetected, lastCount, backend, status }`. `framesSeen` counts the video's `requestVideoFrameCallback`s; `framesDetected` counts finished `detect` calls.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run tests** `?grep=live-yolo`. Expected: FAIL (`__liveStats` undefined).
- [ ] **Step 3: Implement `live/yolo/index.html` and `app.js`.**
  - **Start-up:** load settings → `fetchModel` (show a `.progress` bar; on `ModelDownloadError`, `showError` with a Retry action) → `createDetector` → `listLenses` → `LiveCameraSource.open`. On `CameraPermissionError`, `showError` with the body `Camera access is off. Open Settings → Safari (or Brave) → Camera → Allow, then tap Retry.` and a Retry action.
  - **Detection loop:** `for await` over `source.frames()`: `detect` → store `lastBoxes` → `image.close()`.
  - **Draw loop:** a separate `requestAnimationFrame` loop redraws the overlay from `lastBoxes` with `fitCover` and a resize-aware canvas sized to `clientWidth*dpr`. It also updates the status line and shows `lowFpsHint` when it returns non-null.
  - **Switching lens:** `stop()` the source and reopen it with the new `deviceId`.
  - **Recording:**
    - Start: `Mp4Encoder.create({ ...capTo1080(meta.width, meta.height), fps: meta.fps })`.
    - Each detected frame: draw the frame and `drawDetections` (scale = output width / meta.width) onto an OffscreenCanvas, then `addFrame(canvas, t - tStart)`.
    - Stop: `finish()`, then `saveFile(blob, 'sightline-live-<ISO time>.mp4')`. If it returns `'cancelled'` or `'downloaded'`, show a download link.
  - **Registration:** call `register-sw.js`.
- [ ] **Step 4: Run tests** `?grep=live-yolo`. Expected: `passed: 1, failed: 0`. Then load `http://localhost:8000/live/yolo/?source=file&clip=../../tests/fixtures/bus-3s.mp4` in the browser pane at the `mobile` preset, take a screenshot and check: boxes on the bus and people, the status line, and the footer text. Repeat at landscape 844×390 and check the boxes still line up.
- [ ] **Step 5: Commit** `git commit -m "feat(live): live YOLO app with lens switch, status and recording"`.

---

### Task 14: Recorded processing (`recorded/yolo/process.js`)

**Files:**
- Create: `recorded/yolo/process.js`
- Test: `tests/process.test.js`

**Interfaces:**
- Consumes: `FileVideoSource` (Task 8), `Detector` (Task 7).
- Produces:
  - `processClip(source, detector, { step = 1, conf = 0.35, iou = 0.45, startFrame = 0, prior = null, signal, onProgress }) → Promise<{ detections: Array<Box[] | null>, times: number[], completed: boolean, lastFrame: number }>`.
    - Both arrays have length `meta.frameCount`, indexed by absolute frame number.
    - Entries before `startFrame` are copied from `prior` when given, otherwise `null`.
    - With `step = 2`, odd frames reuse the previous frame's boxes.
    - `onProgress(done, total, etaSeconds)` is called after each frame.
    - If `signal` aborts or the decoder throws, it stops, closes the current frame, calls `source.stop()` and resolves with `completed: false` and `lastFrame` = the last fully processed index.
  - `estimateSeconds(frameCount, step, msPerFrame) → number` = `frameCount / step * msPerFrame / 1000`.
  - `summarize(detections) → Array<{ label, frames }>`: the number of frames each label appears in (counted once per frame), sorted descending.
  - `frameIndexAt(times, t) → number`: index of the nearest time (binary search).

- [ ] **Step 1: Write the failing test**

```js
import { test, assert, assertEqual, fixture } from './harness.js'
import { processClip, estimateSeconds, summarize, frameIndexAt } from '../recorded/yolo/process.js'
import { FileVideoSource } from '../recorded/video-source.js'
import { createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
const det = async () => createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
const car = { label: 'car' }, bus = { label: 'bus' }
test('process: summarize', () => assertEqual(summarize([[car, car], [car, bus], [], null]), [{ label: 'car', frames: 2 }, { label: 'bus', frames: 1 }]))
test('process: estimateSeconds', () => assertEqual(estimateSeconds(1800, 2, 100), 90))
test('process: frameIndexAt', () => { assertEqual(frameIndexAt([0, 0.033, 0.066], 0.04), 1); assertEqual(frameIndexAt([0, 0.033, 0.066], 9), 2) })
test('process: step 2 over bus clip', async () => {
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { step: 2 })
  assertEqual([r.detections.length, r.times.length, r.completed], [90, 90, true])
  assertEqual(r.detections[1], r.detections[0]); assert(r.detections.some(d => d.some(b => b.label === 'bus')))
})
test('process: startFrame resumes', async () => {
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { startFrame: 45 })
  assertEqual(r.detections.findIndex(d => d !== null), 45)
})
test('process: processClip cancel stops early', async () => {
  const ac = new AbortController()
  const r = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(),
    { signal: ac.signal, onProgress: done => { if (done === 10) ac.abort() } })
  assertEqual(r.completed, false); assert(r.lastFrame >= 9 && r.lastFrame <= 20, String(r.lastFrame))
  const again = await processClip(await FileVideoSource.open(await fixture('bus-3s.mp4')), await det(), { step: 3 })
  assertEqual(again.completed, true)
})
```

- [ ] **Step 2: Run tests** `?grep=process`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `recorded/yolo/process.js`.** The ETA uses the mean time per processed frame so far.
- [ ] **Step 4: Run tests** `?grep=process`. Expected: `passed: 6, failed: 0`.
- [ ] **Step 5: Commit** `git commit -m "feat(recorded): clip processing with step, resume, cancel and summary"`.

---

### Task 15: Recorded export and the Recorded YOLO app (`recorded/yolo/`)

**Files:**
- Create: `recorded/yolo/export.js`, `recorded/yolo/index.html`, `recorded/yolo/app.js`
- Test: `tests/recorded-yolo.test.js`

**Interfaces:**
- Consumes: Tasks 6–10, 12 and 14.
- Produces:
  - `exportClip(blob, detections, { showLabels = true, signal, onProgress }) → Promise<Blob>`.
    - Reopens `FileVideoSource`, creates `Mp4Encoder` with `capTo1080(meta.width, meta.height)` / `meta.fps` and `readAudio()` (if any).
    - For each frame: draws frame + `drawDetections(detections[index] ?? [], { scale: out.width / meta.width })`, then `addFrame(canvas, f.t)`.
    - Then `addAudioChunks`, then `finish()`.
  - **Page flow:** title `Sightline Studio`, then Choose (`<input type="file" accept="video/*">`), Settings, Process, Review, Export, using `.app` panels.
    - **Settings:** stored under `recorded-yolo-settings`, defaults `{ conf: 0.35, inputSize: 640, step: 1, showLabels: true }`.
    - **Before processing:** if `meta.duration > 120`, `confirm()` with `Clip is <m:ss> long. Processing will take about <formatEta(estimateSeconds(...))>. Continue?`, using `detector.warmupMs`.
    - **While processing:** a progress bar with percent and ETA, and a Cancel button. Hold `navigator.wakeLock.request('screen')` (try/catch; re-request on `visibilitychange` → visible).
    - **If processing ends early** with `completed: false` while not cancelled, then when the page is next visible, call `processClip` again with `startFrame: lastFrame + 1` and `prior` set to the previous result.
    - **Review:** a `<video>` of the object URL with `object-fit: contain` and an overlay redrawn per `requestVideoFrameCallback` via `frameIndexAt(times, metadata.mediaTime)` and `fitContain`, plus a `summarize` list (`car ×412 frames`).
    - **Export:** a progress bar, then `saveFile(blob, '<original name>-yolo.mp4')`, with a download link on `'cancelled'` / `'downloaded'`.
    - **Errors:** `UnsupportedCodecError`, `VideoOpenError` and `EncoderUnsupportedError` are shown through `showError`.

- [ ] **Step 1: Write the failing test**

```js
import { test, assertEqual, assertClose, skip, fixture } from './harness.js'
import { exportClip } from '../recorded/yolo/export.js'
import { processClip } from '../recorded/yolo/process.js'
import { FileVideoSource } from '../recorded/video-source.js'
import { createDetector } from '../core/detect/detector.js'
import { fetchModel, MODEL_URLS } from '../shared/models.js'
const run = async name => {
  const blob = await fixture(name), det = await createDetector({ modelBytes: await fetchModel(MODEL_URLS[320]), inputSize: 320 })
  const { detections } = await processClip(await FileVideoSource.open(blob), det, { step: 2 })
  try { return await FileVideoSource.open(await exportClip(blob, detections)) }
  catch (e) { if (e.name === 'EncoderUnsupportedError') skip('H.264 encoding unavailable'); throw e }
}
test('recorded-yolo: exportClip keeps frames, duration, audio', async () => {
  const out = await run('bus-3s.mp4')
  assertEqual([out.meta.frameCount, out.meta.hasAudio], [90, true]); assertClose(out.meta.duration, 3.0, 0.034)
})
test('recorded-yolo: exportClip without audio', async () => {
  const out = await run('bus-3s-noaudio.mp4'); assertEqual([out.meta.frameCount, out.meta.hasAudio], [90, false])
})
```

- [ ] **Step 2: Run tests** `?grep=recorded-yolo`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `export.js`, `index.html` and `app.js`** to the interfaces. Call `register-sw.js`.
- [ ] **Step 4: Run tests** `?grep=recorded-yolo`. Expected: `passed: 2, failed: 0` (or `skipped: 2` with the same note as Task 9).
- [ ] **Step 5: Manual check in the browser pane.** Open `http://localhost:8000/recorded/yolo/` and choose `tests/fixtures/bus-3s-rot90.mp4` with the file input. Process at 640, then take a screenshot of the review screen. Check that the boxes sit on the bus in the upright picture and that the summary lists `bus` and `person`.
- [ ] **Step 6: Commit** `git commit -m "feat(recorded): YOLO clip processing app with review and MP4 export"`.

---

### Task 16: README, deployment steps and iPhone checklist

**Files:**
- Create: `README.md`, `docs/iphone-checklist.md`

- [ ] **Step 1: Write `README.md`.** Cover:
  - what the two apps are;
  - running locally (`static` preview, `tests/`);
  - regenerating the models (`tools/export_yolo.ipynb`);
  - deploying: create a GitHub repo, push `main`, then Settings → Pages → Deploy from branch `main` / root. The site is `https://<user>.github.io/<repo>/`.
  - the AGPL-3.0 note for YOLO11n.
- [ ] **Step 2: Write `docs/iphone-checklist.md`** with the spec 3.6 manual checks as checkboxes:
  - both apps install from Safari's Share → Add to Home Screen with names `Sightline Live` and `Sightline Studio`;
  - Live: both lenses selectable; status shows WebGPU in Safari, and WebGPU or the WASM fallback in Brave; denying the camera shows the Settings message; a 30-second recording saves to Photos; rotating the phone keeps boxes aligned;
  - Recorded: a 1-minute iPhone clip in HEVC and one in Most Compatible both process, review and export to Photos with audio; leaving the page mid-process and returning resumes; a clip over 2 minutes shows the warning;
  - Tasks 9 and 15's encoder tests pass when `tests/` is opened in Safari on the iPhone.
- [ ] **Step 3: Run the full suite.** `http://localhost:8000/tests/` with no grep. Expected: `failed: 0`, and any skips are only the H.264 encoder skips noted in Tasks 9 and 15.
- [ ] **Step 4: Commit** `git commit -m "docs: README, deployment and iPhone checklist"`.

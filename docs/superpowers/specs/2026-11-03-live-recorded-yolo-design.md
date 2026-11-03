# Live + Recorded CV Web Apps — Architecture and YOLO Design

Date: 2026-11-03
Status: Draft for review

## 1. Purpose and context

Reproduce the experiment in Michael Milford's LinkedIn post: AI-built phone apps for
live YOLO detection, telephoto panoramas, 3D reconstruction and video mosaics. The
goal is breadth across the four tools, not production polish.

### What the user said

- Goal: reproduce the experiment; rough is acceptable, breadth matters.
- Toolchain: whatever works best.
- Device: iPhone 12, using Safari or Brave.
- Approach: web apps opened in the iPhone browser (approach A).
- Two separate apps: a **Live** app using the camera directly, and a **Recorded** app
  fed with videos filmed beforehand.
- The Live app contains YOLO and Panorama only.

### Assumptions

- The iPhone 12 is the base model: rear Wide and Ultra Wide lenses, no telephoto, no LiDAR.
- The iPhone runs iOS 26, so Safari exposes WebGPU. WASM is the fallback either way.
- Brave on iOS uses WebKit, so it behaves like Safari for camera, motion sensors and
  WebGPU. Brave Shields may block third-party script hosts, which is why libraries are
  vendored (section 2.5).
- The user has a GitHub account for GitHub Pages hosting.

### What the post's apps do that these apps cannot

The post's apps are native Android (Camera2 physical lens IDs, LiteRT "GPU delegate").
In a browser on an iPhone 12, these apps will not have:

- a telephoto lens, physical lens IDs, focal length or shutter readouts;
- full-resolution stills (frames come at video-stream resolution);
- native-speed inference (YOLO frame rate will be lower).

## 2. Architecture

### 2.1 Two apps, one site

Both apps are static pages hosted on GitHub Pages under `/live/` and `/recorded/`.
Each has its own web app manifest, so each gets its own home-screen icon and name.
They share an origin, so the YOLO model is downloaded and cached once for both.

| | Live app | Recorded app |
|---|---|---|
| Input | iPhone camera + motion sensors | Video files from Photos/Files |
| Tools | YOLO, Panorama (gyro-guided) | YOLO, Panorama, Mosaic, 3D |
| Pace | Real time; skips frames while busy | Offline; every frame; as slow as needed |

### 2.2 Frame-source interface

Every tool reads frames through one interface and does not know which app it runs in.

```js
source.meta                 // { width, height, fps, duration?, live: boolean }
for await (const f of source.frames()) {
  // f = { image, t, motion? }
  //   image:  VideoFrame or ImageBitmap; the consumer calls close() on it
  //   t:      seconds from the start of the source
  //   motion: { yaw, pitch, roll, rotationRate } — live sources only
}
source.stop()
```

- `LiveCameraSource` (`live/live-camera.js`) wraps `getUserMedia`. It yields only the
  newest frame when the consumer is ready, so lag never accumulates. It attaches the
  latest motion reading from `live/motion.js`.
- `FileVideoSource` (`recorded/video-source.js`) demuxes an MP4/MOV with mp4box.js and
  decodes every frame in order with WebCodecs `VideoDecoder`. It has no `motion`.

### 2.3 Engines

Engines in `core/` hold the processing logic. They take frames or images in and
return plain data. They never touch the DOM, the camera, files or the network
(model bytes are passed in by the caller).

### 2.4 Repo layout

```
index.html              – choose Live or Recorded
core/
  detect/               – YOLO preprocessing, output decoding, NMS, class colours
  stitch/               – (Panorama sub-project)
  layout/               – (Mosaic sub-project)
  recon/                – (3D sub-project)
shared/
  ui.css                – design system
  frame-source.js       – interface documentation and shared helpers
  models.js             – model download, Cache Storage, backend selection
  encoder.js            – frames (+ optional audio passthrough) → MP4
  vendor/               – local copies of third-party libraries
live/
  manifest.webmanifest
  live-camera.js  motion.js
  yolo/  panorama/
recorded/
  manifest.webmanifest
  video-source.js
  yolo/  panorama/  mosaic/  reconstruct/
models/                 – yolo11n-320.onnx, yolo11n-640.onnx
tests/                  – browser test page for core/ and shared/
tools/                  – Colab notebook for exporting the model
```

Folders marked as later sub-projects are not created in the YOLO sub-project.

### 2.5 Technology

- Plain ES modules with an import map. No bundler and no build step.
- Libraries are **vendored** in `shared/vendor/`, not loaded from a CDN, so Brave
  Shields cannot block them and the apps keep working offline after the first visit.
  For the YOLO sub-project: ONNX Runtime Web, mp4box.js, mp4-muxer. Each library is
  pinned to an exact version, recorded in `shared/vendor/VERSIONS.md`.
- `models.js` creates ONNX Runtime sessions, trying the WebGPU execution provider
  first and falling back to WASM. GitHub Pages cannot send the COOP/COEP headers that
  multi-threaded WASM needs, so the WASM fallback runs single-threaded (with SIMD).
  No service-worker workaround is attempted in this sub-project.
- `encoder.js` encodes with WebCodecs `VideoEncoder` (H.264) and muxes with mp4-muxer.
  It accepts frames with explicit timestamps, so the same code serves live recording
  and offline export. It can copy an AAC audio track from the source without re-encoding.
- Files are saved via the Web Share API (`navigator.share` with files) to reach Photos
  or Files, with a download link as fallback.

### 2.6 Design system (`shared/ui.css`)

A dark theme shared by both apps:

- navy background, one mint accent colour;
- small uppercase section headers;
- pill-shaped buttons and monospace numeric readouts;
- landscape layout: menu on the left, viewport in the middle, tools on the right;
- portrait layout: the side panels collapse into a bottom sheet.

The apps use their own names, not the post's.

### 2.7 Sub-projects and build order

Each sub-project gets its own spec → plan → build cycle.

1. **YOLO** — this spec (section 3). It also builds everything in `shared/`, both
   app shells and the launcher.
2. **Panorama** — `core/stitch`; a live front end with gyro-guided auto-capture and
   blur warnings; a recorded front end that picks frames from a slow-pan video by
   sharpness and new image content; stitching with OpenCV.js.
3. **Mosaic** — Recorded app only. Uneven layouts (e.g. 3 + 2), per-clip trim and
   audio, borders, MP4 export.
4. **3D reconstruction** — Recorded app only, phased: 4a chessboard calibration from
   video; 4b scale from a reference object or one measured distance; 4c neural depth
   + SfM; 4d fill/mesh and three.js viewer; 4e saved scans and ZIP export.

## 3. YOLO sub-project

### 3.1 Model

- YOLO11n (Ultralytics), 80 COCO classes, licensed AGPL-3.0. That is acceptable for
  personal use; public distribution would carry AGPL obligations.
- Two fixed-shape ONNX exports: `models/yolo11n-320.onnx` and `models/yolo11n-640.onnx`
  (about 10 MB each, fp32). Fixed shapes run faster on WebGPU than a dynamic one.
- Produced by `tools/export_yolo.ipynb`, which the user runs once on Colab (no local
  Python here). The notebook exports both files without NMS in the graph (NMS runs in JS).
- Output shape `[1, 84, N]`: 4 box values (centre x, centre y, width, height, in
  input-pixel units) followed by 80 class scores, for N candidates
  (N = 2100 at 320, 8400 at 640).

### 3.2 Engine (`core/detect/`)

```js
const det = await createDetector({ modelBytes, inputSize: 320 | 640, backend: 'auto' })
det.backend        // 'webgpu' | 'wasm'
const boxes = await det.detect(image, { conf: 0.35, iou: 0.45 })
// → [{ classId, label, score, box: [x, y, w, h] }] in source-image pixels
det.dispose()
```

Pure functions, tested directly:

- `letterbox(width, height, size)` → `{ scale, padX, padY }`, plus the inverse mapping
  from input-pixel coordinates back to source pixels;
- `decode(output, n, conf)` → candidate boxes, keeping each candidate's top class if
  above `conf`;
- `nms(boxes, iou)` → per-class non-maximum suppression;
- `colorFor(classId)` → a fixed colour per class.

`createDetector` runs one warm-up inference on load. Preprocessing (resize with grey
padding, RGB, CHW float32 normalised to 0–1) is done on an OffscreenCanvas.

### 3.3 Live front end (`live/yolo/`)

Screen:

- camera fills the screen, with a canvas overlay for boxes;
- top bar: app name, lens switch (Wide / Ultra Wide, from `enumerateDevices` labels),
  record button, settings;
- status line: `<n> objects · <WebGPU|WASM> · <fps> fps`;
- footer: `RESEARCH DEMO · NOT A DRIVING AID`;
- settings sheet: confidence threshold, input size (default 320), labels on/off.

Loop: take the newest frame from `LiveCameraSource` and run `detect`. Frames that
arrive while it is busy are dropped. The overlay redraws the latest boxes every
display frame. Each box is drawn in its class colour with a `label NN%` tag above it.

Recording: each displayed frame is drawn together with its boxes onto a canvas
capped at 1080p. That canvas goes to `encoder.js` with the frame's real timestamp.
On stop, the MP4 is saved via the share sheet. While recording, the status line
keeps showing the detection fps, which is expected to drop.

### 3.4 Recorded front end (`recorded/yolo/`)

Flow: **Choose clip → Settings → Process → Review → Export.**

- Settings: input size (default 640), confidence, frame step (every frame, or every
  2nd frame with boxes held over the skipped frame).
- Process: `FileVideoSource` decodes frames in order and `detect` runs on each. Only
  detections are kept in memory, as an array indexed by frame. Frames are closed
  immediately. A progress bar shows the percentage and time remaining, with a Cancel
  button. Screen Wake Lock is requested while processing.
- Review: a scrubber plays the clip with boxes drawn over it, and a summary lists
  each class with the number of frames it appears in (e.g. `car ×412 frames`).
- Export: decode again, draw frame + boxes, encode with `encoder.js` at the source
  resolution (capped at 1080p) and frame rate, copy the source audio track, and save
  via the share sheet.

### 3.5 Error handling

| Situation | Behaviour |
|---|---|
| Camera permission denied | Explain how to allow it in iOS Settings; offer a retry button |
| Model download fails | Show progress and a Retry button; cached after the first success |
| WebGPU unavailable or fails to create a session | Fall back to WASM; status line shows `WASM` |
| Live detection below 3 fps | Hint: switch to Ultra Wide or stop recording |
| Codec cannot be decoded (e.g. HEVC outside Safari) | Message: set Camera → Formats → Most Compatible |
| Page hidden during processing (iOS suspends it) | On return, resume from the last processed frame |
| Clip longer than 2 minutes | Warn with the estimated processing time before starting |
| Share sheet unavailable or cancelled | Offer a download link |

### 3.6 Testing

Automated, run in the browser pane on this PC via `tests/index.html`:

- `letterbox`: round trip source → input → source is exact to within 0.5 px for
  portrait, landscape and square images.
- `decode`: a stored fixture output tensor yields the expected boxes; candidates
  below `conf` are dropped.
- `nms`: overlapping boxes of the same class are suppressed; overlapping boxes of
  different classes are both kept; an empty input returns empty.
- Engine: the real 640 model on a fixture image of a bus with people returns `bus`
  and at least one `person` with score above 0.5.
- `encoder.js` round trip: encode 60 synthetic frames at 30 fps and verify the
  output decodes with `FileVideoSource` to 60 frames lasting 2.0 s.
- Recorded end to end: a short H.264 test clip with audio is processed and exported;
  the export has the same frame count, the same duration (±1 frame) and an audio track.
- Live loop: with the `?source=file` debug option, `LiveCameraSource` plays a clip at
  real-time speed; verify frames are dropped while detection is busy and the status
  line updates.

Manual checklist on the iPhone 12:

- Both apps install to the home screen with distinct names and icons.
- Live: both lenses selectable; WebGPU reported in Safari, and in Brave (or WASM
  fallback works); 30-second recording saves to Photos; rotating the phone keeps the
  overlay aligned.
- Recorded: a 1-minute clip shot on the iPhone (both HEVC and Most Compatible)
  processes, reviews and exports to Photos with audio.

## 4. Out of scope for this sub-project

- Panorama, Mosaic and 3D tools (their own specs later).
- Motion sensors (`live/motion.js` arrives with Panorama).
- Custom-trained classes (e.g. wallabies); the COCO model is used as is.
- Object tracking across frames, box smoothing, per-class filtering.

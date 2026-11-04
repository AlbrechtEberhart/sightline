# Panorama — Design

Date: 2026-11-04
Status: Draft for review
Builds on: [2026-11-03-live-recorded-yolo-design.md](2026-11-03-live-recorded-yolo-design.md) (architecture, frame-source interface, shared shell)

## 1. Purpose and context

Second sub-project of the Sightline apps, which reproduce Michael Milford's LinkedIn experiment.
It covers the post's panorama tool. Rough is acceptable; it has to work on the user's iPhone 12
in Safari or Brave.

### What the user decided

- Panorama goes in **both** apps: Live (camera + gyroscope, auto-capture) and Studio (a recorded
  slow-pan video).
- Shape: **one-row sweep first, grid later.** This round builds a single-row panorama, with an
  engine designed so a multi-row grid can be added in a later round without a rewrite.
- Stitching: **OpenCV.js** for feature matching, with the gyroscope as a hint in Live.
- Output: a JPEG saved through the existing **Share…** / **Save file** buttons.

### Assumptions

- No telephoto lens on the iPhone 12. "Telephoto-like" means digital zoom on the Wide lens. It is
  offered only where Safari exposes camera zoom.
- Scenes are mostly distant (outdoors, cityscapes). Nearby objects will show parallax ghosting.
- The OpenCV.js file (about 10 MB) is downloaded once at build time, with the user's approval at
  that point, and vendored like the other libraries.

### Out of scope this round

Multi-row grids; 360° wrap-around; choosing frames by hand; random-access frame picking in Studio;
exposure or focus locking (Safari does not expose them).

## 2. Prerequisite: shared glue

Before Panorama code, move the code the two YOLO pages still duplicate into `shared/`, so both
new Panorama pages reuse it instead of copying it a third and fourth time:

- `recorded/yolo/wake-lock.js` → `shared/wake-lock.js` (Live Panorama needs it too).
- Settings coercion: a small `shared/settings.js` helper that validates stored settings against a
  per-app schema of allowed values and defaults, replacing each app's hand-written `validSettings`.
- The export stroke-width formula `max(1, min(w, h) / 390)` → one exported function in
  `shared/draw-boxes.js`.
- The detector loader (fetch model with progress → create detector) shared by both YOLO pages.

Behaviour does not change; the existing suite must stay green.

## 3. User flow

### 3.1 Tool switch

Every tool page gets a **YOLO | Panorama** segmented switch in its top bar. These are plain
relative links between the tool pages of the same app. The manifests keep `start_url: "yolo/"`.

### 3.2 Live → Panorama (`live/panorama/`)

1. The camera opens on the Wide lens. A **Zoom** choice (1×, 1.5×, 2×) appears only when the
   video track reports a `zoom` capability, and only offers values inside its range.
2. **Start** asks for motion-sensor permission (iOS only prompts from a tap), then records the
   start orientation.
3. The user turns slowly. A guide line and arrow show the direction. The first clear movement
   (more than 5° of turn) sets the direction, left or right. Photos are taken automatically
   (section 5.1). Warnings appear on screen. Thumbnails of the photos so far fill a strip along
   the bottom.
4. **Done** (or the 12th photo) stops capture and starts stitching, with a progress bar and
   **Cancel**.
5. The result is shown scrollable and zoomable, with **Share…**, **Save file** and **New
   panorama**.

### 3.3 Studio → Panorama (`recorded/panorama/`)

1. **Choose a clip** (same picker as Studio YOLO). Settings: **Lens** (Wide default, Ultra Wide).
2. **Scan** plays through the video once and picks frames (section 5.2), with a progress bar and
   **Cancel**. The picked frames appear as thumbnails with a count, for example "7 frames picked".
3. **Stitch**, with progress and **Cancel**, then the result with **Share…**, **Save file** and
   **Choose another clip**.

## 4. Architecture

```
 Live: LiveCameraSource + motion ─► capture rules (5.1) ─┐
                                                          ├─► Stitcher (worker) ─► JPEG Blob
 Studio: FileVideoSource ─────────► frame picker (5.2) ──┘
```

### 4.1 Files

```
core/stitch/
  sharpness.js     – Laplacian-variance sharpness of a grey thumbnail
  shift.js         – phase-correlation shift between two grey thumbnails (FFT, Hann window)
  thumb.js         – frame → 256×128-padded grey thumbnail (OffscreenCanvas)
  capture.js       – Live capture rules: motion + sharpness → shoot / wait / warning
  select.js        – Studio frame picker: streaming state machine over (shift, sharpness)
  camera-model.js  – lens table, focal length in pixels from field of view, zoom
  geometry.js      – 3×3 maths: rotations, homography → rotation, chaining, wave correction,
                     cylindrical forward/inverse mapping, output bounds and crop
  stitch-worker.js – module worker: OpenCV matching, warping, gain, blending, JPEG
  stitcher.js      – main-thread client for the worker: add photos, progress, result, cancel
shared/lib/opencv.js      – evaluates the OpenCV.js file inside the worker and resolves `cv`
shared/vendor/opencv/     – vendored OpenCV.js + VERSIONS.md row
live/motion.js            – DeviceOrientation/DeviceMotion wrapper, permission, yaw/pitch/roll
live/panorama/            – index.html, app.js
recorded/panorama/        – index.html, app.js
```

Pure-JS modules (`sharpness`, `shift`, `capture`, `select`, `camera-model`, `geometry`) have no
DOM or OpenCV dependency, so the browser test page can test them directly.

### 4.2 Loading OpenCV.js

- Vendored from npm `@techstark/opencv-js` (official OpenCV 4.10 build with `features2d`,
  `calib3d` and `imgproc`). The exact version, byte size and SHA-256 are recorded in
  `shared/vendor/VERSIONS.md` when it is downloaded.
- The page fetches it with the same validated, cached loader as the YOLO model. The loader is
  generalised from `fetchModel(url, onProgress)` to check an expected byte size and SHA-256, and
  stores the file in the `cv-models-v1` cache. `sw.js` skips this file as it skips `.onnx`, so
  it is not cached twice. The page shows download progress.
- The page transfers the bytes to the worker. The worker is a module worker, which cannot use
  `importScripts`, so `shared/lib/opencv.js` evaluates the script text and resolves `cv` once
  the runtime has initialised. It handles both the Promise-style and `onRuntimeInitialized`
  builds.

### 4.3 Stitcher interface

```js
const stitcher = await Stitcher.create({ opencvBytes, focalPx, onProgress })
stitcher.add(imageBitmap, { yawHint })   // yawHint in degrees: Live only
const { blob, width, height, notes } = await stitcher.finish()  // JPEG; notes: e.g. gyro seams
stitcher.cancel()                        // terminates the worker; finish() rejects with AbortError
```

Photos are transferred (not copied) to the worker as `ImageBitmap`s as soon as they are taken
or picked. Matching each new pair starts at once, so most of the matching is finished by the time
capture or scanning ends. The worker closes each bitmap as soon as it has been warped into the
output.

### 4.4 Stitching pipeline (in the worker)

1. **Match neighbours.**
   - Each photo is downscaled to 800 px on its long side and converted to grey.
   - ORB finds up to 2000 features, matched with Hamming brute force and a 0.75 ratio test.
   - `findHomography` with RANSAC (3 px) estimates the homography H.
   - A pair is accepted with at least 30 inliers.
   - The relative rotation is `R = K⁻¹ H K`, made orthonormal with a 3×3 polar decomposition in
     `geometry.js`.
   - In Live, if the matched yaw differs from the gyro yaw by more than 5°, the match is treated
     as failed.
2. **Failure handling** (section 6): Live uses the gyro rotation for that pair; Studio stops at
   that pair.
3. **Focal refinement.** It starts from the lens table. When at least 3 pairs match, the focal
   length is refined from the homographies (the standard rotation-only estimate) and used if it
   is within ±25% of the table value.
4. **Place.** Relative rotations are chained into an absolute rotation per photo, with photo 1 as
   the reference. **Wave correction** then levels the horizon: it finds the up vector normal to
   the plane of the cameras' x-axes and rotates everything so that up is vertical.
5. **Project.** Each photo is projected onto a cylinder of radius f using `cv.remap`, with maps
   built from `geometry.js`. Output bounds are computed first. If the area would exceed 16 MP
   (Safari's canvas limit), the scale is reduced uniformly.
6. **Gain compensation.** Each photo gets a gain from the mean brightness of its overlaps with its
   neighbours (a least-squares fit, as in OpenCV's `GainCompensator`, simplified to a chain).
7. **Blend.** Feathered blending: each pixel is weighted by its distance to its photo's edge, and
   the result is accumulated into a float buffer.
8. **Crop and encode.** The ragged top and bottom are cropped to the largest rectangle inside the
   covered area. The JPEG is encoded with `OffscreenCanvas.convertToBlob({ type: 'image/jpeg',
   quality: 0.9 })`.

**Ready for a grid later:** rotations are full 3D, and matches are stored as a graph of photo
pairs. A grid adds row-to-row edges, a global rotation fit over the graph, and a spherical
projection; steps 1, 3, 6 and 7 stay the same.

### 4.5 Camera model

- The table gives each lens's horizontal field of view on the long side of a 16:9 frame:
  Wide 67°, Ultra Wide 106°. These are derived from the 26 mm and 13 mm equivalent focal lengths
  on a 4:3 sensor whose full width is used for video.
- `focalPx = (longSide / 2) / tan(hfov / 2) × zoom`.
- The field of view used for spacing (section 5.1) is the one along the frame's displayed width:
  about 41° for the Wide lens held upright.

### 4.6 Motion (`live/motion.js`)

- Asks permission through `DeviceOrientationEvent.requestPermission()` and
  `DeviceMotionEvent.requestPermission()` where they exist.
- Converts alpha/beta/gamma to a device rotation matrix (W3C formula), then to the rear camera's
  view direction, giving yaw and pitch, and roll about the view axis. Angles are relative to the
  orientation recorded at Start.
- Takes the rotation rate (°/s) from `devicemotion`.
- `LiveCameraSource` gains an optional `motion` argument and attaches the latest reading to each
  frame as `f.motion`, as the frame-source interface already describes.

## 5. Picking photos

### 5.1 Live capture rules (`capture.js`)

- **Step.** A photo is due each time the yaw since the last photo reaches 0.65 × the displayed
  horizontal field of view, that is, about 35% overlap. For the Wide lens held upright that is
  about 27°.
- **Shoot** when a photo is due and all of these hold:
  - the rotation rate is below 30°/s;
  - pitch and roll are within 8° of their values at Start;
  - the frame's sharpness is at least 0.8 × the median of the last 15 frames' sharpness.
- **Warnings:**
  - **"Slow down"** above 40°/s;
  - **"Keep level"** when pitch or roll is out of range;
  - **"Go back a little"** when the yaw since the last photo exceeds 0.9 × the field of view
    without a shot, which would leave less than 10% overlap.
- **Photo.** `createImageBitmap(frame)` at full stream resolution, plus the yaw for the hint.
- **Limits:** auto Done at 12 photos. Done with fewer than 2 photos shows "Not enough turning".

### 5.2 Studio frame picker (`select.js`)

- **Per frame:** a grey thumbnail (`thumb.js`), its sharpness, and its phase-correlation shift
  from the previous frame. The horizontal shift is accumulated and scaled to full-resolution
  pixels.
- **Direction** is set when the accumulated shift first exceeds 0.1 × the frame width W.
- **Targets** are at k × 0.65 W. Inside the window target ± 0.1 W, the sharpest frame is picked.
  The first photo is the sharpest frame before the movement passes 0.1 W.
- **End of clip.** If at least 0.3 W of movement has followed the last pick, the sharpest frame
  of the final stretch is added as the last photo.
- **Memory.** Only the frames inside the current window keep a full-resolution `ImageBitmap`. All
  others are closed straight away.
- **Warnings and limits:**
  - "Pan was fast" when any per-frame shift exceeds 0.15 W;
  - at most 12 photos ("Used the first 12 frames of the pan");
  - total movement below 0.5 W shows "Not enough panning".

## 6. Errors and edge cases

| Situation | Behaviour |
|---|---|
| OpenCV.js download fails or fails the size/hash check | Error card with **Retry**; the bad file is never cached or evaluated |
| Motion permission denied | Card: "Panorama needs motion access. Reload the page and tap Allow." |
| No `zoom` capability | Zoom control hidden |
| Page hidden during capture | Capture pauses; photos kept; on return the user continues or taps **Done** |
| Page hidden during scan or stitch | The work continues when visible. If iOS reloaded the page: "The panorama was lost when the app was closed." |
| A pair fails to match (Live) | The gyro rotation is used; notes: "One seam was placed from the gyroscope and may be visible" |
| A pair fails to match (Studio) | Frames before the failure are stitched if there are at least 2; message "Stitched frames 1–5; frame 6 didn't match." Otherwise an error card |
| Cancel | `stitcher.cancel()` terminates the worker, and the photos it holds are discarded because they were transferred to it. Live returns to the camera, ready for a new panorama; Studio returns to the chosen clip, ready to scan again |
| Output over 16 MP | Scaled down uniformly before projection |
| Wake lock | Held during capture, scan and stitch (`shared/wake-lock.js`) |

Known limits, documented in the README and checklist and not fixed: parallax ghosting for objects
nearer than a few metres; moving people or cars appearing doubled or faded in overlaps; no 360°
wrap.

## 7. Testing

On the browser test page, so the suite also runs on the deployed site.

- **Unit tests (exact expectations):**
  - `sharpness`: a blurred copy scores lower than the sharp original.
  - `shift`: a known synthetic offset is recovered to ±0.5 px.
  - `capture`: scripted motion and sharpness sequences give the expected shoot and warning events.
  - `select`: scripted shift and sharpness sequences give the expected picks and messages.
  - `camera-model`: focal length values.
  - `geometry`: rotation round trips, homography from a known rotation back to the rotation,
    wave correction on tilted chains, cylindrical map round trip, crop rectangle.
- **End-to-end with ground truth (`tests/fixtures/synthetic-pan.js`):**
  1. A seeded, richly textured synthetic panorama is drawn on a canvas (no download).
  2. A virtual camera with the Wide lens's focal length renders a yaw sweep from it, with a
     slight pitch tilt.
  3. The frames are encoded with `Mp4Encoder` to make a pan clip.
  4. The Studio pipeline runs on the clip: pick, then stitch.
  5. The test asserts that each photo's estimated yaw is within 0.3° of the truth, the horizon is
     level within 0.5°, and the output covers the swept range.
  6. A second test feeds the same frames and scripted motion through the Live capture rules and
     the stitcher.
- **Failure tests:** a featureless clip gives the Studio "didn't match" result; a static clip
  gives "Not enough panning"; `cancel()` rejects `finish()` with AbortError and terminates the
  worker; a corrupted OpenCV download is rejected by the size and hash check.
- **iPhone checklist** (`docs/iphone-checklist.md`):
  - the motion permission prompt, and the denied message;
  - auto-capture while turning, and the warnings;
  - a 5–8 photo outdoor panorama without visible seams;
  - Zoom shown or hidden correctly, and a 2× panorama;
  - a Studio slow-pan clip filmed on the phone;
  - time and memory at 12 photos;
  - Share… and Save file with the JPEG;
  - offline after first use.

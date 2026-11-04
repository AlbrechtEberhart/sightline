# Sightline

Two on-device computer vision web apps for iPhone, built as static pages with no build step. Everything runs in the browser; no video leaves the phone.

- **Sightline Live** ([`live/yolo/`](live/yolo/)): YOLO11n object detection on the live camera. Switch between the Wide and Ultra Wide lenses, see a status line (objects, engine, fps), and record an annotated MP4.
- **Sightline Studio** ([`recorded/yolo/`](recorded/yolo/)): pick a video from Photos or Files, process every frame offline, review the boxes on a scrubber, and export an annotated MP4 with the original audio.
- **Panorama** in both apps ([`live/panorama/`](live/panorama/) and [`recorded/panorama/`](recorded/panorama/)): stitch a wide photo from a slow turn, shot live or taken from a video. Use the **YOLO | Panorama** switch at the top of each page.

The launcher is [`index.html`](index.html). Offline support comes from [`sw.js`](sw.js) and the cached model.

This project reproduces the experiment from a LinkedIn post by Michael Milford. The post's apps were native Android; these are iPhone 12 web apps. The design, including what they cannot do compared with the post, is in [the design spec](docs/superpowers/specs/2026-11-03-live-recorded-yolo-design.md).

## Using the apps

Camera settings for best results:

- Camera → Formats → **Most Compatible** (H.264). HEVC also works in Safari.
- Lock focus and exposure for scans.

Saving: when the MP4 is ready, both apps show two buttons. **Share…** opens the share sheet (Zalo, Messages, AirDrop, Save Video); iOS only opens it from a tap, and the button is hidden where the browser cannot share files. **Save file** downloads the MP4: to the Downloads folder on a PC, or to Files > Downloads on iPhone. A web page cannot send a file to Zalo directly, so Zalo is reached through the share sheet.

Known limits:

- No telephoto on the iPhone 12, and no lens IDs, focal length or shutter readouts.
- Live stills come at video-stream resolution.
- The YOLO frame rate is lower than native.
- WASM runs single-threaded, because GitHub Pages cannot send the COOP/COEP headers that multi-threaded WASM needs.
- COCO classes only. Wallabies show up as dog or sheep, and a sideways bus may read as truck.

## Panorama

Both apps stitch a panorama on the phone and give you a JPEG. The first visit to a Panorama page downloads OpenCV.js 4.10 (about 10.4 MB), which is then cached for offline use.

**Live** (`live/panorama/`):

1. Pick a zoom if the choice appears (1×, 1.5×, 2×). It shows only where Safari exposes camera zoom, and the last choice is remembered.
2. Tap **Start** and allow motion access when asked.
3. Stand still and turn slowly, about one turn of the body, in one direction. The first clear turn sets the direction. Photos are taken automatically, and the strip at the bottom shows them. Warnings appear if you turn too fast or the view is blurry.
4. Hold the phone upright for up to 12 photos, or in landscape for up to 7. Live stops by itself at the limit, because a panorama is limited to about 340°. Rotating the phone mid-capture shows "Keep the phone the same way up" and skips frames until you turn it back.
5. Tap **Done**, wait for the stitch, then use **Share…** or **Save file**.

**Studio** (`recorded/panorama/`):

1. Film a slow pan: stand still, hold the phone steady and upright, and turn on the spot at an even, slow pace. Avoid tilting up and down.
2. Choose the clip, pick the **Lens** (Wide or Ultra Wide) that filmed it, and tap **Scan**. The app picks frames about 0.5–0.65 of a frame width apart (35–50% overlap).
3. Tap **Stitch**, then **Share…** or **Save file**.

Behaviour in both apps:

- A panorama longer than about 340° keeps the first photos and says "Used the first N photos (the panorama is limited to about 340°)".
- A scan or capture hidden mid-way pauses and resumes when you return. Navigating Back to a Panorama page reloads it.

Known limits:

- Ghosting for objects nearer than a few metres (parallax).
- Moving people or cars appear doubled or faded in the overlaps.
- No 360° wrap.

## Running locally

No Node and no Python are needed. Start the dev server with PowerShell from the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8000
```

Then open:

- `http://localhost:8000/`: the launcher.
- `http://localhost:8000/live/yolo/` and `http://localhost:8000/recorded/yolo/`: the apps.
- `http://localhost:8000/tests/`: the browser test page. Add `?grep=<name>` to run only matching tests.

To try the apps on the phone, use the deployed HTTPS URL (see [Deploying to GitHub Pages](#deploying-to-github-pages)). The PC dev server cannot be reached from an iPhone.

The browser tab must stay visible while the tests run, because the video and frame tests need rendering.

The service worker is skipped on localhost unless you add `?sw=1` to the URL.

The launch configuration is in [`.claude/launch.json`](.claude/launch.json) (name `static`, port 8000).

The automated tests and the manual iPhone checks are described in [the design spec, section 3.6](docs/superpowers/specs/2026-11-03-live-recorded-yolo-design.md#36-testing).

## Models

The detector uses two fixed-shape ONNX exports of YOLO11n, in [`models/`](models/):

- `yolo11n-320.onnx`
- `yolo11n-640.onnx`

To regenerate them, run [`tools/export_yolo.ipynb`](tools/export_yolo.ipynb) on Google Colab, then extract the downloaded zip into the repo root. The steps, the export settings and the Ultralytics and torch versions used are in [`models/README.md`](models/README.md).

Vendored libraries (ONNX Runtime Web, mp4box.js, mp4-muxer and OpenCV.js) are pinned in [`shared/vendor/VERSIONS.md`](shared/vendor/VERSIONS.md). They are never loaded from a CDN at runtime.

## Licence note

YOLO11n is from Ultralytics and is licensed under **AGPL-3.0**. That is acceptable for personal use. Public distribution of this app or of the model weights would carry AGPL obligations, so review them first or obtain an Ultralytics enterprise licence. See [`models/README.md`](models/README.md#licence).

## Deploying to GitHub Pages

1. Create a GitHub repo and push this repo's default branch, `master` (or whatever your default branch is). (Pushing is your step.)
2. Go to **Settings → Pages** and choose **Deploy from branch**, that same branch (`master`) / root.
3. The site is at `https://<user>.github.io/<repo>/`.
4. On the iPhone, open the Live and Studio pages in Safari and choose **Share → Add to Home Screen**. The names are Sightline Live and Sightline Studio.

Manual checks on the iPhone are in [`docs/iphone-checklist.md`](docs/iphone-checklist.md).

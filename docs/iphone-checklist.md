# iPhone 12 checklist

Manual checks on a real iPhone 12, run against the deployed site at `https://<user>.github.io/<repo>/` (see [the README](../README.md#deploying-to-github-pages)). An iPhone cannot reach the PC's `localhost`, and camera access and the service worker need HTTPS, so the PC dev server is only for the browser tests on the PC. Tick each item in Safari unless the item says otherwise. The spec's manual checks are in [section 3.6](superpowers/specs/2026-11-03-live-recorded-yolo-design.md#36-testing).

## Install

- [ ] Both apps install from Safari's Share → Add to Home Screen, named `Sightline Live` and `Sightline Studio`.
- [ ] The two home-screen icons have distinct names and distinct icons.

## Sightline Live

- [ ] Both lenses (Wide and Ultra Wide) can be selected.
- [ ] The status line shows `WebGPU` in Safari.
- [ ] In Brave, the status line shows `WebGPU` or `WASM`, and detection works either way.
- [ ] Denying the camera shows the message to allow it in iOS Settings, with a Retry button.
- [ ] A 30-second recording saves to Photos via **Share… → Save Video**.
- [ ] Rotating the phone keeps the boxes aligned with the objects.
- [ ] Rotating the phone during a recording stops it with "Recording stopped: orientation changed", and the **Share…** and **Save file** buttons still appear.
- [ ] Return from the home screen after 30 s: the camera reopens.

## Sightline Studio

- [ ] A 1-minute iPhone clip in HEVC processes, reviews and exports to Photos with audio.
- [ ] A 1-minute iPhone clip in Most Compatible (H.264) processes, reviews and exports to Photos with audio.
- [ ] **Share…** opens the share sheet. **Save Video** saves to Photos, and **Zalo** sends the clip (e.g. to "My Cloud" so it can be opened in Zalo PC).
- [ ] **Save file** downloads the MP4 to Files > Downloads, both in Safari and from the Home Screen app.
- [ ] On a PC (Chrome or Edge), Studio exports a clip and **Save file** puts it in the Downloads folder.
- [ ] A 1080p 60 fps clip exports. This checks the H.264 level choice.
- [ ] The exported clip keeps the source audio in sync with the picture.
- [ ] Leaving the page during processing and returning resumes from the last processed frame.
- [ ] A clip longer than 2 minutes shows the warning with the estimated processing time.
- [ ] Export a 3–5 minute clip and note whether it completes. This is a memory check; the app warns before exporting clips over 3 minutes.
- [ ] Process and review a clip trimmed in the Photos app: the boxes line up with the objects during review.
- [ ] Process and export a default HDR (HEVC) iPhone clip: the colours in the export look reasonable.

## Panorama

The first visit to each Panorama page downloads OpenCV.js (about 10.4 MB), so allow a moment on the first run. The spec's checks are in [section 7](superpowers/specs/2026-11-04-panorama-design.md#7-testing).

Live (`live/panorama/`):

- [ ] **Start** shows the motion permission prompt. Denying it shows "Panorama needs motion access. Reload the page and tap Allow."
- [ ] Turning slowly takes photos automatically, and the strip fills. Turning too fast or a blurry view shows a warning.
- [ ] A 5–8 photo outdoor panorama stitches with no visible seams.
- [ ] **Zoom** (1×, 1.5×, 2×) is shown only if Safari exposes camera zoom, and hidden otherwise. A 2× panorama works, and the choice is remembered on the next visit.
- [ ] Holding the phone upright, the capture stops at 12 photos. Note the time and whether memory holds at 12 photos.
- [ ] Holding the phone in landscape, the capture stops at 7 photos.
- [ ] Rotating the phone mid-capture shows "Keep the phone the same way up" and skips frames until it is turned back.
- [ ] **Share…** and **Save file** work with the JPEG.
- [ ] Navigating Panorama → YOLO → Back works, and the Panorama page reloads cleanly.

Studio (`recorded/panorama/`):

- [ ] A slow-pan clip filmed on the phone: choose it, pick the Lens, tap **Scan**, then **Stitch**. The result looks right.
- [ ] Switching apps mid-scan, then returning, finishes the scan.
- [ ] **Share…** and **Save file** work with the JPEG.
- [ ] Navigating Panorama → YOLO → Back works.

Known limits to look for (not bugs): ghosting for objects nearer than a few metres, moving people or cars doubled or faded in overlaps, and no 360° wrap (over about 340° the app says "Used the first N photos").

## Tests

Run these in Safari on the iPhone. Keep the browser tab visible while they run, because the encoder tests need rendering.

- [ ] Open `<site>/tests/?grep=encoder` (covers `tests/encoder.test.js`). All encoder tests pass.
- [ ] Open `<site>/tests/?grep=recorded-yolo` (covers `tests/recorded-yolo.test.js`). All tests pass.
- [ ] Report any test shown as "skipped" in the notes. Skips are only expected for the H.264 encoder check when the browser cannot encode.

## Offline

- [ ] Open each app once, and wait until the model has finished loading (the loading message goes away and detection runs). Then turn on airplane mode. Both apps still open and run. The app shell and the model are cached separately, so both steps are needed.
- [ ] Run the offline check from the installed home-screen icons, not from Safari: iOS keeps the storage of home-screen apps separate from Safari's, so a cache filled in Safari does not help them.
- [ ] Open each Panorama page once and wait for the engine to load (the download message goes away), then go offline from the installed home-screen icons. Both Panorama pages still open and stitch.
- [ ] In Studio, run Process once at each input size you'll use offline before going offline. Each input size is a separate model download.

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
- [ ] A 30-second recording saves to Photos via the **Save** button. The share sheet opens and saves to Photos.
- [ ] Rotating the phone keeps the boxes aligned with the objects.
- [ ] Rotating the phone during a recording stops it with "Recording stopped: orientation changed", and the **Save** button still appears.
- [ ] Return from the home screen after 30 s: the camera reopens.

## Sightline Studio

- [ ] A 1-minute iPhone clip in HEVC processes, reviews and exports to Photos with audio.
- [ ] A 1-minute iPhone clip in Most Compatible (H.264) processes, reviews and exports to Photos with audio.
- [ ] The **Save** button opens the share sheet and saves to Photos.
- [ ] A 1080p 60 fps clip exports. This checks the H.264 level choice.
- [ ] The exported clip keeps the source audio in sync with the picture.
- [ ] Leaving the page during processing and returning resumes from the last processed frame.
- [ ] A clip longer than 2 minutes shows the warning with the estimated processing time.
- [ ] Export a 3–5 minute clip and note whether it completes. This is a memory check; the app warns before exporting clips over 3 minutes.
- [ ] Process and review a clip trimmed in the Photos app: the boxes line up with the objects during review.
- [ ] Process and export a default HDR (HEVC) iPhone clip: the colours in the export look reasonable.

## Tests

Run these in Safari on the iPhone. Keep the browser tab visible while they run, because the encoder tests need rendering.

- [ ] Open `<site>/tests/?grep=encoder` (covers `tests/encoder.test.js`). All encoder tests pass.
- [ ] Open `<site>/tests/?grep=recorded-yolo` (covers `tests/recorded-yolo.test.js`). All tests pass.
- [ ] Report any test shown as "skipped" in the notes. Skips are only expected for the H.264 encoder check when the browser cannot encode.

## Offline

- [ ] Open each app once, and wait until the model has finished loading (the loading message goes away and detection runs). Then turn on airplane mode. Both apps still open and run. The app shell and the model are cached separately, so both steps are needed.
- [ ] Run the offline check from the installed home-screen icons, not from Safari: iOS keeps the storage of home-screen apps separate from Safari's, so a cache filled in Safari does not help them.
- [ ] In Studio, run Process once at each input size you'll use offline before going offline. Each input size is a separate model download.

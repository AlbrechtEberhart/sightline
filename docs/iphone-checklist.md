# iPhone 12 checklist

Manual checks on a real iPhone 12, run after deploying (see [the README](../README.md#deploying-to-github-pages)) or on the local dev server. Tick each item in Safari unless the item says otherwise. The spec's manual checks are in [section 3.6](superpowers/specs/2026-11-03-live-recorded-yolo-design.md#36-testing).

## Install

- [ ] Both apps install from Safari's Share → Add to Home Screen, named `Sightline Live` and `Sightline Studio`.

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

## Tests

- [ ] Open `tests/` in Safari on the iPhone. The encoder tests from Tasks 9 and 15 pass.

## Offline

- [ ] After one visit with a connection, turn on airplane mode. Both apps still open and run.

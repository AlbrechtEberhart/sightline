# models/

ONNX weights used by the YOLO detector (`core/detect/`). The `.onnx` files are generated, not hand-written.

| File | Input | Output | Size |
| --- | --- | --- | --- |
| `yolo11n-320.onnx` | `[1, 3, 320, 320]` | `[1, 84, 2100]` | about 10 MB |
| `yolo11n-640.onnx` | `[1, 3, 640, 640]` | `[1, 84, 8400]` | about 10 MB |

Output layout: 4 box values (centre x, centre y, width, height, in input-pixel units), then 80 COCO class scores, for each candidate. Non-maximum suppression is not in the graph; it runs in JS.

## Regenerate

This machine has no Python, so the export runs on Google Colab.

1. Open [Colab](https://colab.research.google.com/) and choose File > Upload notebook, then pick `tools/export_yolo.ipynb`.
2. Run all cells (Runtime > Run all). A CPU runtime is enough. Each verification cell asserts, so a failed check stops the run.
3. The last cell downloads `yolo_assets.zip`. Extract it into the repo root. It contains:
   - `models/yolo11n-320.onnx`, `models/yolo11n-640.onnx`
   - `tests/fixtures/bus.jpg`, `bus-3s.mp4`, `bus-3s-noaudio.mp4`, `bus-3s-rot90.mp4`
4. Check that both `.onnx` files are between 9 MB and 12 MB.

Export settings: Ultralytics `>=8.3.40,<9` (the notebook installs the newest release in that range, plus `onnx`, `onnxscript`, `onnxslim` and `onnxruntime`), `format='onnx'`, `opset=17`, `simplify=True`, `dynamic=False`, `nms=False`, fp32. Fixed shapes run faster on WebGPU than a dynamic one.

The notebook sets `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1` because current Colab torch (2.6+) otherwise refuses to load the Ultralytics checkpoint. It prints the exact `ultralytics` and `torch` versions it used. Those exact versions are recorded here after the run:

- ultralytics: (not yet run)
- torch: (not yet run)

## Licence

YOLO11n is from Ultralytics and is licensed under AGPL-3.0. That is acceptable for personal use. Public distribution of this app or these weights would carry AGPL obligations (source availability for the whole combined work), so review them first or obtain an Ultralytics enterprise licence.

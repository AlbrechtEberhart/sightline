# Vendored libraries

Downloaded from cdn.jsdelivr.net on 2026-11-03 and committed unmodified. Never loaded from a CDN at runtime.
Import them only through shared/lib/ wrappers.

| File | Package@version | Source URL | Bytes | SHA-256 |
|---|---|---|---|---|
| ort/ort.webgpu.min.mjs | onnxruntime-web@1.20.1 | https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs | 333468 | e1a0817ac08d5a6ade7f229754c2aecd444bff0bd22c259ca148a04b9f9e9f65 |
| ort/ort-wasm-simd-threaded.jsep.mjs | onnxruntime-web@1.20.1 | https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.jsep.mjs | 46839 | 2fb14505d39926e4c544de8c57fe59a2f2bc74caba6f71890be9afecc5046758 |
| ort/ort-wasm-simd-threaded.jsep.wasm | onnxruntime-web@1.20.1 | https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.jsep.wasm | 21663894 | 185b0861a6cd6cbdfb057289338090436483cc59e10a7bc83bd167b15531a51b |
| mp4box.mjs | mp4box@0.5.2 | https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm | 140677 | 90cad6e7eb27fab68bbd19fdfc9ce84ad018a12958c2b8c8344122f6b43b57a5 |
| mp4-muxer.mjs | mp4-muxer@5.1.3 | https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs | 67989 | e239cb3fa122c48bc9cefda504c301a52edafbc27c1506f19f8c33480084bdf7 |
| opencv/opencv.js | @techstark/opencv-js@4.10.0-release.1 | https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js | 10378215 | 19b46167b59efbef9cc3836264b0b657110833e4b1df84282004b8b3141c048d |

## Notes

- ORT: ort.webgpu.min.mjs is the WebGPU (JSEP) ESM entry. At runtime it dynamically imports ort-wasm-simd-threaded.jsep.mjs and fetches ort-wasm-simd-threaded.jsep.wasm from ort.env.wasm.wasmPaths (set in shared/lib/ort.js). The non-JSEP ort-wasm-simd-threaded.{mjs,wasm} are not used by this build and are not vendored. ort.env.wasm.numThreads = 1.
- mp4box: the +esm bundle has no jsDelivr imports. It ends with a //# sourceMappingURL=/sm/... comment that is only used by devtools; left untouched so the hash matches the CDN.
- mp4-muxer: plain ESM build.
- opencv.js: UMD build (wasm embedded, no separate .wasm file) used by Panorama. The page downloads it with fetchAsset, which checks the pinned size and SHA-256 (shared/models.js, OPENCV_ASSET) and caches it in Cache Storage. The bytes are posted to a module worker, where shared/lib/opencv.js evaluates them with indirect eval. It is excluded from sw.js caching so it is not stored twice.

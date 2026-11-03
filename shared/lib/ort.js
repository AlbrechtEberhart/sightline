// onnxruntime-web 1.20.1 (WebGPU/JSEP build), vendored. See ../vendor/VERSIONS.md.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs'

// Load ort-wasm-simd-threaded.jsep.{mjs,wasm} from the vendored folder, never a CDN.
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href
// Single-threaded WASM: iOS Safari pages are not cross-origin isolated.
ort.env.wasm.numThreads = 1

export { ort }

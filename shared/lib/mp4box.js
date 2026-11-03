// mp4box 0.5.2 (jsDelivr +esm bundle), vendored. See ../vendor/VERSIONS.md.
import * as ns from '../vendor/mp4box.mjs'

const MP4Box = ns.default
// Make sure the classic MP4Box.DataStream / MP4Box.createFile surface is present.
if (!MP4Box.DataStream) MP4Box.DataStream = ns.DataStream
if (!MP4Box.createFile) MP4Box.createFile = ns.createFile

export default MP4Box

// Hand a Blob to the iOS share sheet, or fall back to a plain download.

function defaultDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function saveFile(blob, filename, nav = navigator, download = defaultDownload) {
  const file = new File([blob], filename, { type: blob.type })
  if (nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file] }); return 'shared' } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'
      // Any other share failure (e.g. expired user gesture): fall through to a download.
    }
  }
  download(URL.createObjectURL(blob), filename)
  return 'downloaded'
}

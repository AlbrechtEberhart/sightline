// Offer a finished MP4 two ways: the share sheet (Zalo, Messages, AirDrop, Save Video on
// iPhone) and a plain file download (Downloads on a PC, Files > Downloads on iPhone).

const fileFor = (blob, filename) => new File([blob], filename, { type: blob.type })

/** True when this browser can hand a file to the share sheet. */
export function canShareFile(blob, filename, nav = navigator) {
  try { return !!nav.canShare?.({ files: [fileFor(blob, filename)] }) } catch { return false }
}

/**
 * Open the share sheet with the file.
 *
 * MUST be called directly from a user-gesture handler (e.g. a "Share" button click),
 * never at the end of an async export chain: navigator.share needs transient user
 * activation, which WebKit drops across a long await such as an encode/export.
 *
 * @returns {Promise<'shared'|'cancelled'>} rejects on any other failure
 */
export async function shareFile(blob, filename, nav = navigator) {
  try { await nav.share({ files: [fileFor(blob, filename)] }); return 'shared' } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled'
    throw e
  }
}

/**
 * Wire a Share button and a "Save file" link to one finished clip.
 * Save file is a real <a download> link, the most reliable download on both iOS and desktop.
 * Share is shown only where the browser can share files. onError gets share failures (not cancels).
 */
export function createSaveControls({ share, save, onError, nav = navigator }) {
  let blob = null
  let filename = ''
  let url = null

  // Direct click handler: shareFile needs the user gesture, so nothing is awaited before it.
  share.addEventListener('click', () => {
    if (blob) shareFile(blob, filename, nav).catch(onError)
  })

  function clear() {
    blob = null
    if (url) URL.revokeObjectURL(url)
    url = null
    share.hidden = true
    save.hidden = true
    save.removeAttribute('href')
  }

  function offer(nextBlob, nextFilename) {
    clear()
    blob = nextBlob
    filename = nextFilename
    url = URL.createObjectURL(blob)
    save.href = url
    save.download = filename
    save.hidden = false
    share.hidden = !canShareFile(blob, filename, nav)
  }

  return { offer, clear, get ready() { return blob !== null } }
}

// Screen wake lock held while processing or exporting. Every call is safe without the API
// (or when the request is refused): the work still runs, the screen may just dim.
export function createWakeLock(nav = navigator, doc = document) {
  let want = false
  let lock = null
  let pending = null

  async function request() {
    if (!want || lock || pending || doc.hidden || !nav.wakeLock) return
    try {
      pending = nav.wakeLock.request('screen')
      const l = await pending
      if (!want) { l.release().catch(() => {}); return }
      lock = l
      l.addEventListener('release', () => { if (lock === l) lock = null })
    } catch { /* not allowed (battery saver, no activation) */ } finally {
      pending = null
    }
  }

  return {
    /** Wants the lock and requests it now. Never rejects. */
    acquire() { want = true; return request() },
    /** Re-requests after the page is visible again (the browser drops the lock on hide). */
    request,
    release() {
      want = false
      const l = lock
      lock = null
      l?.release().catch(() => {})
    },
  }
}

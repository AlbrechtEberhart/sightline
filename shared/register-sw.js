// Registers the site-wide service worker (sw.js at the site root).
// Skipped on localhost unless the page URL has ?sw=1.
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
const forced = new URLSearchParams(location.search).get('sw') === '1'

if ('serviceWorker' in navigator && (!isLocal || forced)) {
  const swUrl = new URL('../sw.js', import.meta.url)
  const scope = new URL('./', swUrl).href
  navigator.serviceWorker.register(swUrl.href, { scope }).catch((err) => {
    console.warn('service worker registration failed', err)
  })

  // On first load the page and its scripts were fetched before the worker controlled
  // the page, so hand the worker the URLs this page already used for caching.
  navigator.serviceWorker.ready.then((reg) => {
    const urls = [location.href, ...performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => new URL(u).origin === location.origin)]
    reg.active?.postMessage({ type: 'cache-urls', urls: [...new Set(urls)] })
  }).catch(() => {})
}

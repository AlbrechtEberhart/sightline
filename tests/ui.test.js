import { test, assertEqual } from './harness.js'
import { formatEta, loadSettings, saveSettings } from '../shared/ui.js'
test('ui: formatEta', () => { assertEqual(formatEta(45), '45 s'); assertEqual(formatEta(185), '3 min 05 s'); assertEqual(formatEta(NaN), '—'); assertEqual(formatEta(Infinity), '—') })
test('ui: settings survive storage failure', () => {
  const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') }, configurable: true })
  try { saveSettings('k', { a: 1 }); assertEqual(loadSettings('k', { a: 2 }), { a: 2 }) }
  finally { Object.defineProperty(window, 'localStorage', orig) }
})
test('ui: manifests valid', async () => {
  for (const [p, name] of [['../live/manifest.webmanifest', 'Sightline Live'], ['../recorded/manifest.webmanifest', 'Sightline Studio']]) {
    const m = await (await fetch(new URL(p, import.meta.url))).json()
    assertEqual([m.name, m.display, m.icons.length, m.start_url, m.scope], [name, 'standalone', 3, 'yolo/', './'])
  }
})

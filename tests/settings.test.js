import { test, assertEqual } from './harness.js'
import { coerceSettings } from '../shared/settings.js'

const S = { conf: { default: 0.35, range: [0.1, 0.9] }, size: { default: 640, oneOf: [320, 640] }, labels: { default: true } }

test('settings: clamps, defaults and drops unknown keys', () => {
  assertEqual(coerceSettings({ conf: 5, size: 320, labels: false, junk: 1 }, S), { conf: 0.9, size: 320, labels: false })
  assertEqual(coerceSettings({ conf: 'x', size: 500, labels: 'yes' }, S), { conf: 0.35, size: 640, labels: true })
  assertEqual(coerceSettings({ conf: NaN }, S), { conf: 0.35, size: 640, labels: true })
})

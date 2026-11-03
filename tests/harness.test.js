import { test, assert, assertEqual, assertClose, skip } from './harness.js'
test('harness: assertEqual deep', () => assertEqual({ a: [1, 2] }, { a: [1, 2] }))
test('harness: assertClose', () => assertClose(0.1 + 0.2, 0.3, 1e-9))
test('harness: assert throws on false', () => {
  let threw = false; try { assert(false, 'x') } catch { threw = true }
  assert(threw, 'assert(false) must throw')
})
test('harness: skip marks skipped', () => skip('demo'))

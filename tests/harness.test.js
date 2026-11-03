import { test, assert, assertEqual, assertClose, skip } from './harness.js'
test('harness: assertEqual deep', () => assertEqual({ a: [1, 2] }, { a: [1, 2] }))
test('harness: assertClose', () => assertClose(0.1 + 0.2, 0.3, 1e-9))
test('harness: assert throws on false', () => {
  let threw = false; try { assert(false, 'x') } catch { threw = true }
  assert(threw, 'assert(false) must throw')
})
test('harness: skip marks skipped', () => skip('demo'))
test('harness: assertEqual rejects differences', () => {
  const rejects = (a, b) => {
    let threw = false; try { assertEqual(a, b) } catch { threw = true }
    assert(threw, `assertEqual must throw for ${a} vs ${b}`)
  }
  rejects({ a: [1, 2] }, { a: [1, 3] })
  rejects(new Map([[1, 2]]), new Map([[3, 4]]))
  rejects(new Date(0), new Date(1))
})

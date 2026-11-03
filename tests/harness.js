// Minimal browser test harness. No dependencies, no build step.

export class SkipError extends Error {
  constructor(reason) { super(reason); this.name = 'SkipError' }
}

const registry = []
let currentFile = ''

// Set by the runner before importing each test file, so tests know their file.
export function setCurrentFile(name) { currentFile = name }

export function test(name, fn) {
  registry.push({ name, fn, file: currentFile })
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const tag = Object.prototype.toString.call(a)
  if (tag === '[object Date]') return Object.is(a.getTime(), b.getTime())
  if (tag === '[object Map]') {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false
    return true
  }
  if (tag === '[object Set]') {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  if (ArrayBuffer.isView(a) && tag !== '[object DataView]') {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }
  if (tag !== '[object Object]' && tag !== '[object Array]') {
    throw new Error(`assertEqual: unsupported type ${tag}`)
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

function show(v) {
  const replacer = (k, x) => (x instanceof Map ? { Map: [...x] } : x instanceof Set ? { Set: [...x] } : x)
  try { return JSON.stringify(v, replacer) } catch { return String(v) }
}

export function assertEqual(actual, expected, msg = '') {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${show(expected)} but got ${show(actual)}`)
  }
}

export function assertClose(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${actual} to be within ${tol} of ${expected}`)
  }
}

export function skip(reason = '') {
  throw new SkipError(reason)
}

export async function fixture(name) {
  const url = new URL(`./fixtures/${name}`, import.meta.url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`)
  return res.blob()
}

export async function fixtureImage(name) {
  return createImageBitmap(await fixture(name))
}

const TIMEOUT_MS = 60000

function withTimeout(promise, ms, name) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${name}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function run({ grep = '', onResult } = {}) {
  const results = { done: false, passed: 0, failed: 0, skipped: 0, results: [] }
  window.__testResults = results
  const record = (name, status, message = '') => {
    results.results.push({ name, status, message })
    if (status === 'pass') results.passed++
    else if (status === 'fail') results.failed++
    else results.skipped++
    if (onResult) onResult(results.results[results.results.length - 1])
  }

  let manifest = []
  try {
    manifest = (await import('./manifest.js')).default
    if (!Array.isArray(manifest)) throw new Error('default export is not an array')
  } catch (err) {
    manifest = []
    record('manifest.js', 'fail', `import error: ${err && err.message ? err.message : err}`)
  }
  for (const file of manifest) {
    setCurrentFile(file)
    try {
      await import(`./${file}`)
    } catch (err) {
      record(file, 'fail', `import error: ${err && err.message ? err.message : err}`)
    }
  }
  setCurrentFile('')

  const selected = registry.filter((t) => !grep || t.name.includes(grep) || t.file.includes(grep))
  for (const t of selected) {
    try {
      await withTimeout(Promise.resolve().then(t.fn), TIMEOUT_MS, t.name)
      record(t.name, 'pass')
    } catch (err) {
      if (err instanceof SkipError) record(t.name, 'skip', err.message)
      else record(t.name, 'fail', err && err.message ? err.message : String(err))
    }
  }
  results.done = true
  return results
}

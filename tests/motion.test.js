import { test, assert, assertEqual, assertClose, fixture } from './harness.js'
import { orientationToCamera, createMotion } from '../live/motion.js'
import { zoomRange, setZoom, LiveCameraSource } from '../live/live-camera.js'

const orient = (alpha, beta, gamma) => Object.assign(new Event('deviceorientation'), { alpha, beta, gamma })

test('motion: upright facing forward is level', () => {
  const c = orientationToCamera(0, 90, 0)
  assertClose(c.pitch, 0, 0.01)
  assertClose(c.roll, 0, 0.01)
})
test('motion: turning left is negative yaw', () => {
  assertClose(orientationToCamera(30, 90, 0).yaw - orientationToCamera(0, 90, 0).yaw, -30, 0.01)
})
test('motion: tilting up is positive pitch', () => {
  assertClose(orientationToCamera(0, 100, 0).pitch, 10, 0.01)
})
test('motion: side tilt is roll', () => {
  // Rolling an upright phone 10 degrees about the camera axis (facing north, top towards east).
  // Near upright, alpha and gamma are degenerate, so this is the gimbal-edge triple (-90, 80, 90).
  const c = orientationToCamera(-90, 80, 90)
  assertClose(Math.abs(c.roll), 10, 0.01)
  assert(Math.abs(c.pitch) < 0.5, `pitch ${c.pitch}`)
  assertClose(c.yaw, 0, 0.01)
  assert(c.roll > 0, 'top tilted to the right is positive roll')
  const w = orientationToCamera(90, 100, -90) // same pose in the W3C range an iPhone reports
  assertClose(Math.abs(w.roll), 10, 0.01)
  assert(Math.abs(w.pitch) < 0.5, `pitch ${w.pitch}`)
})
test('motion: gamma on an upright phone is a turn, not a roll', () => {
  // Gamma rotates about the device y axis, which is vertical when upright.
  const c = orientationToCamera(0, 90, 10)
  assertClose(c.yaw, -10, 0.01)
  assertClose(c.roll, 0, 0.01)
  assertClose(c.pitch, 0, 0.01)
})
test('motion: landscape screen angle keeps level view level', () => {
  // Device on its side (beta 0, gamma -90) held in landscape: camera level, no roll.
  const c = orientationToCamera(0, 0, -90, 90)
  assertClose(c.pitch, 0, 0.01)
  assertClose(c.roll, 0, 0.01)
})
test('motion: reading is relative to zero and wraps', () => {
  const win = new EventTarget(), m = createMotion(win)
  assertEqual(m.reading(), null)
  m.start()
  win.dispatchEvent(orient(170, 90, 0))
  m.zero()
  win.dispatchEvent(orient(-170, 90, 0))
  const r = m.reading()
  assertClose(r.yaw, -20, 0.01)
  assertClose(r.pitch, 0, 0.01)
  m.stop()
})
test('motion: zero before the first event uses that event as origin', () => {
  const win = new EventTarget(), m = createMotion(win)
  m.start()
  m.zero()
  assertEqual(m.reading(), null)
  win.dispatchEvent(orient(170, 90, 0))
  assertClose(m.reading().yaw, 0, 0.01)
  win.dispatchEvent(orient(-170, 90, 0))
  assertClose(m.reading().yaw, -20, 0.01)
  m.stop()
})
test('motion: window.orientation is the screen angle fallback', () => {
  const win = new EventTarget(), m = createMotion(win)
  win.orientation = -90 // iOS < 16.4, no screen.orientation
  m.start()
  win.dispatchEvent(orient(0, 0, 90)) // landscape the other way: screen angle 270
  const r = m.reading()
  assertClose(r.pitch, 0, 0.01)
  assertClose(r.roll, 0, 0.01) // level: roll would be 90 in magnitude if the angle were read as 0
  m.stop()
})
test('motion: null angles give no reading; rate is rotation magnitude', () => {
  const win = new EventTarget(), m = createMotion(win)
  m.start()
  win.dispatchEvent(orient(null, null, null))
  assertEqual(m.reading(), null)
  win.dispatchEvent(orient(0, 90, 0))
  assertEqual(m.reading().rate, 0)
  win.dispatchEvent(Object.assign(new Event('devicemotion'), { rotationRate: { alpha: 3, beta: 4, gamma: 12 } }))
  assertClose(m.reading().rate, 13, 1e-9)
  m.stop()
  win.dispatchEvent(orient(10, 90, 0))
  assertClose(m.reading().yaw, 0, 0.01) // listener removed
})
test('motion: permission denied', async () => {
  const win = new EventTarget()
  win.DeviceOrientationEvent = { requestPermission: async () => 'denied' }
  win.DeviceMotionEvent = { requestPermission: async () => 'granted' }
  assertEqual(await createMotion(win).requestPermission(), 'denied')
})
test('motion: permission granted where no prompt exists', async () => {
  assertEqual(await createMotion(new EventTarget()).requestPermission(), 'granted')
  const win = new EventTarget()
  win.DeviceOrientationEvent = { requestPermission: async () => 'granted' }
  win.DeviceMotionEvent = { requestPermission: async () => 'granted' }
  assertEqual(await createMotion(win).requestPermission(), 'granted')
  win.DeviceMotionEvent = { requestPermission: async () => { throw new Error('nope') } }
  assertEqual(await createMotion(win).requestPermission(), 'denied')
})
test('motion: zoomRange null without capability', () => {
  assertEqual(zoomRange({ getCapabilities: () => ({}) }), null)
  assertEqual(zoomRange({}), null)
  assertEqual(zoomRange(null), null)
  assertEqual(zoomRange({ getCapabilities: () => ({ zoom: { min: 1, max: 5, step: 0.1 } }) }), { min: 1, max: 5 })
})
test('motion: setZoom applies an advanced zoom constraint', async () => {
  let got = null
  await setZoom({ applyConstraints: async (c) => { got = c } }, 2.5)
  assertEqual(got, { advanced: [{ zoom: 2.5 }] })
})
test('motion: camera frames carry the motion reading; debug source has no track', async () => {
  const s = await LiveCameraSource.open({ debugFile: await fixture('bus-3s.mp4'), motion: { reading: () => ({ yaw: 7 }) } })
  assertEqual(s.track, null)
  const f = (await s.frames().next()).value
  f.image.close(); s.stop()
  assertEqual(f.motion, { yaw: 7 })
})
test('motion: frames without a motion option have motion undefined', async () => {
  const s = await LiveCameraSource.open({ debugFile: await fixture('bus-3s.mp4') })
  const f = (await s.frames().next()).value
  f.image.close(); s.stop()
  assertEqual(f.motion, undefined)
})

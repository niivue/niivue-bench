// Multi-instance shared canvas (iiif-volumetric-demo sheet viewer, port 8087, needs its /api): minimap wheel-zoom and
// count committed frames whose last default-framebuffer op was the app's clearCanvas() (a blank WebGL2 frame).
// MODE=pan: right-drag flicks on the sheet, released each time, so the controller's inertia rAF tick drives apply.
// usage: node tools/sheet-zoom.mjs [outdir] [label]   env: BACKENDS (webgl2,webgpu), SECS (4), MODE (wheel|pan), DY (40)
import { chromium } from 'playwright-core'
const [out, label = 'run'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] })
const hooks = () => {
  window.st = { frames: 0, blank: 0, clears: 0, renders: 0, on: false }
  let defaultFb = true, dirty = false
  const gl = WebGL2RenderingContext.prototype
  const bfb = gl.bindFramebuffer, clr = gl.clear
  gl.bindFramebuffer = function (t, fb) { if (t !== this.READ_FRAMEBUFFER) defaultFb = !fb; return bfb.call(this, t, fb) }
  gl.clear = function (m) { if (defaultFb && /clearCanvas/.test(new Error().stack)) { dirty = true; st.clears++ } return clr.call(this, m) }
  for (const n of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'blitFramebuffer']) {
    const f = gl[n]
    gl[n] = function (...a) { if (defaultFb || n === 'blitFramebuffer') { if (dirty) st.renders++; dirty = false } return f.apply(this, a) }
  }
  // Message posted from rAF runs after this frame's rendering update has been committed.
  const tick = () => {
    if (st.on) { const c = new MessageChannel(); c.port1.onmessage = () => { st.frames++; if (dirty) st.blank++ }; c.port2.postMessage(0) }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
const SECS = Number(process.env.SECS ?? 4)
for (const be of (process.env.BACKENDS ?? 'webgl2,webgpu').split(',')) {
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  await p.addInitScript(hooks)
  await p.goto(`http://localhost:8087/sheet.html?backend=${be}`)
  await p.waitForFunction(() => /cells/.test(document.body.innerText), null, { timeout: 60000 })
  await p.waitForTimeout(3000)
  // The sheet blocks wheel on the main canvas (capture listener); wheel zoom goes through the minimap.
  const m = await p.locator('#minimap').boundingBox()
  await p.mouse.move(m.x + m.width * 0.5, m.y + m.height * 0.5)
  await p.evaluate(() => { st.on = true })
  const t0 = Date.now()
  if (process.env.MODE === 'pan') {
    const c = await p.locator('#nv-canvas').boundingBox()
    const cx = c.x + c.width * 0.6, cy = c.y + c.height * 0.6
    for (let k = 0; Date.now() - t0 < SECS * 1000; k++) {
      const dir = k % 2 ? -1 : 1
      await p.mouse.move(cx, cy); await p.mouse.down({ button: 'right' })
      for (let j = 1; j <= 6; j++) { await p.mouse.move(cx + dir * 25 * j, cy + dir * 10 * j); await p.waitForTimeout(8) }
      await p.mouse.up({ button: 'right' }) // fast release: inertia continues in the controller's rAF
      await p.waitForTimeout(600)
    }
  }
  let i = 0, shot = 0
  while (process.env.MODE !== 'pan' && Date.now() - t0 < SECS * 1000) {
    await p.mouse.wheel(0, i++ % 60 < 30 ? -Number(process.env.DY ?? 40) : Number(process.env.DY ?? 40))
    await p.waitForTimeout(8)
    if (out && i % 25 === 12) await p.screenshot({ path: `${out}/${label}-${be}-${shot++}.png` })
  }
  await p.waitForTimeout(500)
  const r = await p.evaluate(() => { st.on = false; return { ...st, zoomText: document.body.innerText.match(/zoom [0-9.]+×/g) } })
  console.log(JSON.stringify({ label, be, ...r }))
  await p.close()
}
await b.close()

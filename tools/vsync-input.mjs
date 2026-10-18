// Vsync on, real input driving NiiVue's own handlers: frame pacing and renders per animation frame.
// usage: node tools/vsync-input.mjs [layout=render] [ov=1] [modes=drag,wheel]
// pan = right-drag (NVCanvasViewportController's default pan button; load with QS=&viewport=1)
// env: QS (extra URL params), BACKENDS (webgl2,webgpu), RATE (1), SECS (4), HZ (pointer events per second, 250),
//   READOUT=1 (an app-style text readout updated on every pointermove/wheel), ALPHA (force the WebGPU canvas alphaMode)
import { chromium } from 'playwright-core'
const [layout = 'render', ov = '1', modeArg = 'drag,wheel'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--enable-dawn-features=allow_unsafe_apis'] })

// Renders per animation frame: count frame-starting GPU calls (WebGL2 clear of the default framebuffer, WebGPU getCurrentTexture).
const hooks = ([readout, alpha]) => {
  if (readout) addEventListener('DOMContentLoaded', () => {
    const el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'readout' }))
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px monospace;color:#fff;background:#000a'
    let n = 0
    for (const t of ['pointermove', 'wheel']) addEventListener(t, (e) => { el.textContent = `${++n} ${e.clientX},${e.clientY} ${performance.now().toFixed(1)}` }, { passive: true })
  })
  if (alpha && globalThis.GPUCanvasContext) {
    const c = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function (d) { return c.call(this, { ...d, alphaMode: alpha }) }
  }
  window.renders = 0
  window.lat = [] // ms from a viewport-controller apply to the next render that starts (viewport=1 only)
  const rendered = () => { window.renders++; if (window.lastApply != null) { window.lat.push(performance.now() - window.lastApply); window.lastApply = null } }
  window.events = 0
  for (const t of ['pointermove', 'wheel']) addEventListener(t, () => window.events++, { capture: true, passive: true })
  const gl = WebGL2RenderingContext.prototype
  const bfb = gl.bindFramebuffer, clr = gl.clear
  let defaultFb = true
  gl.bindFramebuffer = function (t, fb) { if (t !== this.READ_FRAMEBUFFER) defaultFb = !fb; return bfb.call(this, t, fb) }
  gl.clear = function (m) { if (defaultFb && this.canvas.id === 'gl1') rendered(); return clr.call(this, m) }
  window.textures = 0
  if (globalThis.GPUDevice) {
    const ct = GPUDevice.prototype.createTexture
    GPUDevice.prototype.createTexture = function (d) { window.textures++; return ct.call(this, d) }
  }
  if (globalThis.GPUCanvasContext) {
    const gct = GPUCanvasContext.prototype.getCurrentTexture
    GPUCanvasContext.prototype.getCurrentTexture = function () { rendered(); return gct.call(this) }
  }
}

const SECS = Number(process.env.SECS ?? 4), HZ = Number(process.env.HZ ?? 250)
for (const be of (process.env.BACKENDS ?? 'webgl2,webgpu').split(',')) {
  for (const mode of modeArg.split(',')) {
    const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
    p.on('pageerror', (e) => console.log('pageerror', e.message))
    await p.addInitScript(hooks, [process.env.READOUT === '1', process.env.ALPHA])
    await p.goto(`${process.env.BASE ?? 'http://localhost:5173/'}v1.html?backend=${be}&rate=${process.env.RATE ?? 1}&dpr=0${process.env.QS ?? ''}`)
    await p.waitForFunction(() => document.getElementById('version').textContent)
    await p.selectOption('#layout', layout); await p.selectOption('#ov', ov)
    await p.waitForTimeout(2500)
    const box = await p.locator('#gl1').boundingBox()
    // Render-tile pointer position: center of the canvas for 'render', the bottom-right (3D) pane for 'multi'.
    const cx = box.x + box.width * (layout === 'multi' ? 0.75 : 0.5), cy = box.y + box.height * (layout === 'multi' ? 0.75 : 0.5)
    await p.mouse.move(cx, cy)
    await p.evaluate(() => {
      const t = [], r = [], e = [], x0 = window.textures
      window.rec = { t, r, e, x0, on: true }
      const f = (ts) => { t.push(ts); r.push(window.renders); e.push(window.events); if (window.rec.on) requestAnimationFrame(f) }
      requestAnimationFrame(f)
    })
    if (mode === 'drag') await p.mouse.down()
    if (mode === 'pan') await p.mouse.down({ button: 'right' })
    const t0 = Date.now()
    let i = 0
    while (Date.now() - t0 < SECS * 1000) {
      i++
      if (mode === 'drag' || mode === 'pan') await p.mouse.move(cx + 120 * Math.sin(i / 40), cy + 40 * Math.cos(i / 55))
      else if (mode === 'wheel') await p.mouse.wheel(0, i % 60 < 30 ? 20 : -20)
      else if (mode === 'hover') await p.mouse.move(cx + 120 * Math.sin(i / 40), cy)
      await p.waitForTimeout(1000 / HZ)
    }
    if (mode === 'drag') await p.mouse.up()
    if (mode === 'pan') await p.mouse.up({ button: 'right' })
    const r = await p.evaluate(() => {
      window.rec.on = false
      const { t, r, e } = window.rec
      const dt = t.slice(1).map((x, i) => x - t[i])
      const per = r.slice(1).map((x, i) => x - r[i])
      const s = [...dt].sort((a, b) => a - b)
      const period = s[s.length >> 1]
      const q = (v, f) => +[...v].sort((a, b) => a - b)[Math.floor(v.length * f)].toFixed(2)
      return {
        frames: dt.length, periodMs: +period.toFixed(2), p95: q(dt, 0.95), p99: q(dt, 0.99), max: +Math.max(...dt).toFixed(1),
        missed: dt.filter((x) => x > period * 1.5).length,
        rendersMean: +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(2), rendersMax: Math.max(...per),
        applyToRenderMs: window.lat.length ? q(window.lat, 0.5) : null,
        texturesPerFrame: +((window.textures - window.rec.x0) / per.length).toFixed(2),
        eventsPerFrame: +((e[e.length - 1] - e[0]) / per.length).toFixed(2),
        rendersPerFrame: { 0: per.filter((x) => x === 0).length, 1: per.filter((x) => x === 1).length, '2+': per.filter((x) => x >= 2).length },
      }
    })
    console.log(JSON.stringify({ be: await p.evaluate(() => nv.backend), mode, layout, ov, ...r }))
    await p.close()
  }
}
await b.close()

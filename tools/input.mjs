// GPU + wall time per frame and GPU API calls per frame, while real pointer input reaches the page.
// usage: node tools/input.mjs [layout=render] [ov=0] [modes=idle,hover,off,drag,wheel]
// env: BACKENDS (webgl2,webgpu), RATE (1), N (200 frames), BASE, CHROME_ARGS
import { chromium } from 'playwright-core'
const [layout = 'render', ov = '0', modeArg = 'idle,hover,off,drag,wheel'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-dawn-features=allow_unsafe_apis', ...(process.env.CHROME_ARGS?.split(' ').filter(Boolean) ?? [])] })

// Counts GPU API calls (window.calls) and records WebGPU first-render-pass timestamps (window.gpuTimes).
const hooks = () => {
  const calls = (window.calls = {})
  const wrap = (proto, names, prefix = '') => {
    if (!proto) return
    for (const n of names) {
      const f = proto[n]
      if (typeof f !== 'function') continue
      proto[n] = function (...a) { calls[prefix + n] = (calls[prefix + n] ?? 0) + 1; return f.apply(this, a) }
    }
  }
  wrap(WebGL2RenderingContext.prototype, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'useProgram', 'compileShader', 'linkProgram',
    'texImage2D', 'texImage3D', 'texSubImage2D', 'texSubImage3D', 'bufferData', 'bufferSubData', 'readPixels', 'bindFramebuffer', 'clear', 'finish', 'flush'], 'gl.')
  wrap(globalThis.GPUCommandEncoder?.prototype, ['beginRenderPass', 'beginComputePass', 'copyTextureToBuffer', 'copyBufferToBuffer', 'copyTextureToTexture'], 'gpu.')
  wrap(globalThis.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed', 'setPipeline'], 'gpu.')
  wrap(globalThis.GPUQueue?.prototype, ['submit', 'writeBuffer', 'writeTexture'], 'gpu.')
  wrap(globalThis.GPUBuffer?.prototype, ['mapAsync'], 'gpu.')
  wrap(globalThis.GPUDevice?.prototype, ['createShaderModule', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createBuffer', 'createTexture', 'createBindGroup'], 'gpu.')
  wrap(globalThis.GPUCanvasContext?.prototype, ['getCurrentTexture', 'configure'], 'gpu.')

  window.gpuTimes = []
  if (!globalThis.GPUAdapter) return
  const rd = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (d = {}) {
    const feats = [...(d.requiredFeatures ?? [])]
    if (this.features.has('timestamp-query')) feats.push('timestamp-query')
    const dev = await rd.call(this, { ...d, requiredFeatures: feats })
    if (!dev.features.has('timestamp-query')) { window.noTs = true; return dev }
    const qs = dev.createQuerySet({ type: 'timestamp', count: 2 })
    const resolve = dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    let pending = false
    const brp = GPUCommandEncoder.prototype.beginRenderPass
    GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
      if (!pending && desc.colorAttachments?.[0]) { pending = true; desc = { ...desc, timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } }
      return brp.call(this, desc)
    }
    const sub = dev.queue.submit.bind(dev.queue)
    dev.queue.submit = (cbs) => {
      sub(cbs)
      if (!pending) return
      pending = false
      const read = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      const enc = dev.createCommandEncoder()
      enc.resolveQuerySet(qs, 0, 2, resolve, 0)
      enc.copyBufferToBuffer(resolve, 0, read, 0, 16)
      sub([enc.finish()])
      read.mapAsync(GPUMapMode.READ).then(() => { const t = new BigUint64Array(read.getMappedRange()); window.gpuTimes.push(Number(t[1] - t[0]) / 1e6); read.unmap(); read.destroy() })
    }
    return dev
  }
}

// In-page timed loop, started without awaiting so Node can send input meanwhile.
const loop = ([N, countRafs]) => {
  const raf = () => new Promise(requestAnimationFrame)
  const after = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0) })
  const be = nv.backend
  const canvas = document.getElementById('gl1')
  const gl = be === 'webgl2' ? canvas.getContext('webgl2') : null
  const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2')
  const wall = [], glq = [], perFrame = []
  let rafs = 0, counting = true
  // a free-running rAF counter by itself puts WebGPU into Chrome's slow state (RAFS=1 to enable)
  const tick = () => { rafs++; if (counting) requestAnimationFrame(tick) }
  if (countRafs) tick()
  const snap = () => ({ ...window.calls })
  const g0 = window.gpuTimes.length
  ;(async () => {
    const c0 = snap()
    const tStart = performance.now()
    for (let i = 0; i < N; i++) {
      const q = ext ? gl.createQuery() : null
      let before
      const pr = raf().then(async () => {
        const t0 = performance.now()
        before = snap()
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        await after()
        if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); glq.push(q) }
        if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
        else await canvas.getContext('webgpu').getConfiguration().device.queue.onSubmittedWorkDone()
        wall.push(performance.now() - t0)
        const now = snap(), d = {}
        for (const k in now) if (now[k] !== (before[k] ?? 0)) d[k] = now[k] - (before[k] ?? 0)
        perFrame.push(d)
      })
      nv.azimuth = 110 + 2 * i
      await pr
    }
    const elapsed = performance.now() - tStart
    counting = false
    const c1 = snap(), total = {}
    for (const k in c1) if (c1[k] !== (c0[k] ?? 0)) total[k] = c1[k] - (c0[k] ?? 0)
    for (let i = 0; i < 20; i++) await raf()
    const gpu = gl ? glq.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 : NaN).filter((x) => !Number.isNaN(x)) : window.gpuTimes.slice(g0)
    const med = (v) => { const s = [...v].sort((a, b) => a - b); return +(s[s.length >> 1] ?? NaN).toFixed(2) }
    const p95 = (v) => { const s = [...v].sort((a, b) => a - b); return +(s[Math.floor(s.length * 0.95)] ?? NaN).toFixed(2) }
    const series = []
    for (let i = 0; i + 40 <= gpu.length; i += 40) series.push(med(gpu.slice(i, i + 40)))
    // calls per measured frame (median per key) and calls landing outside measured frames
    const keys = Object.keys(total)
    const perFrameMed = Object.fromEntries(keys.map((k) => [k, med(perFrame.map((d) => d[k] ?? 0))]))
    const outside = Object.fromEntries(keys.map((k) => [k, total[k] - perFrame.reduce((s, d) => s + (d[k] ?? 0), 0)]).filter(([, v]) => v))
    window.done = { be, canvas: `${canvas.width}x${canvas.height}`, n: gpu.length, rafsPerFrame: countRafs ? +(rafs / N).toFixed(2) : null, msPerFrame: +(elapsed / N).toFixed(2),
      wallMed: med(wall.slice(20)), wallP95: p95(wall.slice(20)), gpuMed: med(gpu.slice(20)), gpuP95: p95(gpu.slice(20)), series, perFrameMed, outside }
  })()
}

const N = Number(process.env.N ?? 200)
for (const be of (process.env.BACKENDS ?? 'webgl2,webgpu').split(',')) {
  for (const mode of modeArg.split(',')) {
    const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
    p.on('pageerror', (e) => console.log('pageerror', e.message))
    p.on('console', (m) => m.type() === 'error' && console.log('  err', m.text().slice(0, 200)))
    await p.addInitScript(hooks)
    await p.goto(`${process.env.BASE ?? 'http://localhost:5173/'}v1.html?backend=${be}&rate=${process.env.RATE ?? 1}&dpr=0`)
    await p.waitForFunction(() => document.getElementById('version').textContent)
    await p.selectOption('#layout', layout); await p.selectOption('#ov', ov)
    await p.waitForTimeout(2500)
    const box = await p.locator('#gl1').boundingBox()
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    const kind = mode.replace(/-blocked$/, '')
    // -blocked: same OS input reaches the page, but NiiVue's handlers never see it (scene unchanged)
    if (mode.endsWith('-blocked')) await p.evaluate(() => { for (const t of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'mousedown', 'mousemove', 'mouseup']) window.addEventListener(t, (e) => { e.stopImmediatePropagation(); if (t === 'wheel') e.preventDefault() }, { capture: true, passive: false }) })
    if (mode !== 'idle') await p.mouse.move(cx, cy) // idle: no input at all since page load
    await p.waitForTimeout(500)
    await p.evaluate(loop, [N, process.env.RAFS === '1'])
    let x = 0, down = false
    while (!(await p.evaluate(() => window.done))) {
      x = (x + 6) % 300
      if (kind === 'hover') await p.mouse.move(cx - 150 + x, cy)
      else if (kind === 'off') await p.mouse.move(box.x + box.width + 5, 10 + (x % 100)) // outside the canvas, inside the page
      else if (kind === 'drag') { if (!down) { await p.mouse.down(); down = true } await p.mouse.move(cx - 150 + x, cy) }
      else if (kind === 'wheel') await p.mouse.wheel(0, x % 12 < 6 ? 40 : -40)
      await p.waitForTimeout(8)
    }
    if (down) await p.mouse.up()
    const r = await p.evaluate(() => window.done)
    console.log(JSON.stringify({ mode, layout, ov, ...r }))
    await p.close()
  }
}
await b.close()

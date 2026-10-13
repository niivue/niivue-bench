// GPU-only time per frame: WebGPU timestamp-query on the render pass, EXT_disjoint_timer_query_webgl2 around the frame.
import { chromium } from 'playwright-core'
const [layout = 'render', ov = '0'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.MINFLAGS ? [] : ['--enable-dawn-features=allow_unsafe_apis', '--enable-webgl-draft-extensions'])] })
for (const be of (process.env.BACKENDS ?? 'webgl2,webgpu').split(',')) {
  const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  p.on('console', (m) => m.type() === 'error' && console.log('  err', m.text().slice(0, 200)))
  if (process.env.ALPHA) await p.addInitScript((alpha) => {
    const c = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function (d) {
      const o = { ...d }
      if (alpha !== 'keep') o.alphaMode = alpha
      if (window.__usage === 'ra') o.usage = GPUTextureUsage.RENDER_ATTACHMENT
      return c.call(this, o)
    }
  }, process.env.ALPHA)
  if (process.env.USAGE) await p.addInitScript((u) => { window.__usage = u }, process.env.USAGE)
  if (!process.env.NOHOOK) await p.addInitScript(() => {
    window.gpuTimes = []
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
  })
  await p.goto(`${process.env.BASE ?? 'http://localhost:5173/'}v1.html?${process.env.AUTO ? 'auto=1&' : ''}backend=${be}&rate=${process.env.RATE ?? 1}&dpr=${process.env.DPR ?? 0}&n=${process.env.N ?? 80}`)
  await p.waitForFunction(() => document.getElementById('version').textContent)
  if (!process.env.AUTO) { await p.selectOption('#layout', layout); await p.selectOption('#ov', ov); await p.waitForTimeout(2500) }
  if (!process.env.AUTO) await p.selectOption('#anim', 'rotate')
  await p.evaluate(() => { window.gpuTimes = [] })
  const mode = process.env.MODE ?? 'measure'
  let row
  const jsMeasure = (anim = 'rotate') => p.evaluate(async (anim) => { const r = await bench.measure(nvAdapter, 'render', 0, anim); return [r.ms, r.cpu] }, anim)
  const during = async (anim, act) => {
    await p.evaluate((anim) => { window.mrow = bench.measure(nvAdapter, 'render', 0, anim).then((r) => [r.ms, r.cpu]) }, anim)
    const t0 = Date.now()
    while (Date.now() - t0 < 6000) await act()
    return p.evaluate(() => window.mrow)
  }
  const box = await p.locator('#gl1').boundingBox()
  if (mode === 'clickbody') {
    await p.mouse.click(1100, 10)
    row = await jsMeasure()
  } else if (mode === 'wheel') {
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    row = await during('scroll', async () => { await p.mouse.wheel(0, 50); await p.waitForTimeout(8) })
  } else if (mode === 'drag') {
    let x = box.x + 100
    await p.mouse.move(x, box.y + box.height / 2); await p.mouse.down()
    row = await during('rotate', async () => { x = box.x + 100 + ((x - box.x - 100 + 4) % (box.width - 200)); await p.mouse.move(x, box.y + box.height / 2); await p.waitForTimeout(8) })
    await p.mouse.up()
  } else if (mode === 'movehover') {
    let x = box.x + 100
    row = await during('rotate', async () => { x = box.x + 100 + ((x - box.x - 100 + 4) % (box.width - 200)); await p.mouse.move(x, box.y + box.height / 2); await p.waitForTimeout(8) })
  } else if (mode === 'auto') {
    await p.waitForFunction(() => document.querySelectorAll('#results tr').length >= 3, null, { timeout: 180000 })
    row = await p.$eval('#results tr:nth-child(3)', (tr) => [...tr.cells].map((c) => c.textContent))
  } else if (mode === 'clickwait') {
    await p.click('#runOne')
    await p.waitForFunction(() => document.querySelectorAll('#results tr').length >= 2, null, { timeout: 180000 })
    await p.waitForTimeout(3000)
    await p.evaluate(() => { window.gpuTimes = [] })
    row = await p.evaluate(async () => { const r = await bench.measure(nvAdapter, 'render', 0, 'rotate'); return [r.ms, r.cpu] })
  } else if (mode === 'hover') {
    const b = await p.locator('#runOne').boundingBox()
    await p.mouse.move(b.x + 5, b.y + 5)
    row = await p.evaluate(async () => { const r = await bench.measure(nvAdapter, 'render', 0, 'rotate'); return [r.ms, r.cpu] })
  } else if (mode === 'click') {
    await p.click('#runOne')
    await p.waitForFunction(() => document.querySelectorAll('#results tr').length >= 2, null, { timeout: 180000 })
    row = await p.$eval('#results tr:nth-child(2)', (tr) => [...tr.cells].map((c) => c.textContent))
  } else {
    row = await p.evaluate(async (mode) => {
      if (mode === 'busy') for (const c of document.querySelectorAll('header select, header input, header button')) c.disabled = true
      if (mode === 'jsclick') { document.getElementById('runOne').click(); await new Promise((r) => setTimeout(r, 100)) }
      const r = await bench.measure(nvAdapter, 'render', 0, 'rotate')
      return [r.ms, r.cpu]
    }, mode)
    if (mode === 'jsclick') row = [row[0], row[1]]
  }
  const g = await p.evaluate(() => { const v = window.gpuTimes; const med = (a) => { const s = [...a].sort((x, y) => x - y); return +(s[s.length >> 1] ?? NaN).toFixed(2) }; const series = []; for (let i = 0; i + 100 <= v.length; i += 100) series.push(med(v.slice(i, i + 100))); return { n: v.length, gpuMed: med(v), series } })
  console.log(JSON.stringify({ be, mode, benchMs: row[9] ?? row[0], benchCpu: row[10] ?? row[1], ...g }))
  await p.close(); continue
  const r = await p.evaluate(async (be) => {
    const raf = () => new Promise(requestAnimationFrame)
    const after = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0) })
    const gl = be === 'webgl2' ? document.getElementById('gl1').getContext('webgl2') : null
    const ext = window.gpuTimes ? gl?.getExtension('EXT_disjoint_timer_query_webgl2') : null
    window.gpuTimes ??= []
    const wall = [], glq = []
    const N = Number(new URLSearchParams(location.search).get('n') ?? 80)
    for (let i = 0; i < N; i++) {
      const q = ext ? gl.createQuery() : null
      const pr = raf().then(async () => {
        const t0 = performance.now()
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        await after()
        if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); glq.push(q) }
        if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
        else await document.getElementById('gl1').getContext('webgpu').getConfiguration().device.queue.onSubmittedWorkDone()
        wall.push(performance.now() - t0)
      })
      nv.azimuth = 110 + 2 * i
      await pr
    }
    for (let i = 0; i < 20; i++) await raf()
    const gpu = gl ? glq.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 : NaN).filter((x) => !Number.isNaN(x)) : window.gpuTimes
    const med = (v) => { const s = [...v].sort((a, b) => a - b); return +(s[s.length >> 1] ?? NaN).toFixed(2) }
    const min = (v) => +Math.min(...v).toFixed(2)
    const series = []
    for (let i = 0; i + 20 <= gpu.length; i += 20) series.push(med(gpu.slice(i, i + 20)))
    return { series, be, canvas: `${gl1.width}x${gl1.height}`, ext: !!ext, noTs: !!window.noTs, n: gpu.length, wallMed: med(wall.slice(20)), wallMin: min(wall.slice(20)), gpuMed: med(gpu.slice(20)), gpuMin: min(gpu.slice(20)) }
  }, be)
  console.log(JSON.stringify(r))
  await p.close()
}
await b.close()

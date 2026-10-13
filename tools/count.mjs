// Mean fast/fine ray-march samples per pixel, read back from a frame that encodes the counters as colour.
import { chromium } from 'playwright-core'
const W = {
  wgsl: [
    ['var colAcc = vec4f(0.0);', 'var colAcc = vec4f(0.0);\n\tvar nFine = 0;\n\tvar nFast = 0;'],
    ['let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(samplePos.xyz), 0.0).a;\n\t\t\tif (alpha >= 0.01) {', 'let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(samplePos.xyz), 0.0).a;\n\t\t\tnFast++;\n\t\t\tif (alpha >= 0.01) {'],
    ['let volCoord = chunkTexCoord(samplePos.xyz);', 'nFine++;\n\t\t\t\tlet volCoord = chunkTexCoord(samplePos.xyz);'],
    ['if (colAcc.a <= 0.001) {\n\t\tdiscard;\n\t}', ''],
    ['output.color = output.color * params.fadeAlpha;', 'output.color = vec4f(f32(nFine) / 1024.0, f32(nFast) / 1024.0, 1.0, 1.0);'],
  ],
  glsl: [
    ['vec4 colAcc = vec4(0.0);', 'vec4 colAcc = vec4(0.0);\n  int nFine = 0;\n  int nFast = 0;'],
    ['float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;', 'float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;\n      nFast++;'],
    ['vec3 volCoord = chunkTexCoord(samplePos.xyz);', 'nFine++;\n        vec3 volCoord = chunkTexCoord(samplePos.xyz);'],
    ['if (colAcc.a <= 0.001) {\n    discard;\n  }', ''],
    ['FragColor = FragColor * fadeAlpha;', 'FragColor = vec4(float(nFine) / 1024.0, float(nFast) / 1024.0, 1.0, 1.0);'],
  ],
}
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
for (const be of (process.env.BACKENDS ?? 'webgl2,webgpu').split(',')) {
  const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  p.on('console', (m) => m.type() === 'error' && console.log('  err', m.text().slice(0, 300)))
  await p.addInitScript((subs) => {
    const apply = (code, marker) => {
      if (!code.includes(marker) || !code.includes('rayMarchPass')) return code
      for (const [a, c] of subs) { if (!code.includes(a)) throw new Error('patch miss: ' + a.slice(0, 50)); code = code.replace(a, c) }
      window.patched = (window.patched ?? 0) + 1
      return code
    }
    const o = GPUDevice.prototype.createShaderModule
    GPUDevice.prototype.createShaderModule = function (d) { return o.call(this, { ...d, code: apply(d.code, 'fn fragment_main') }) }
    const os = WebGL2RenderingContext.prototype.shaderSource
    WebGL2RenderingContext.prototype.shaderSource = function (sh, code) { return os.call(this, sh, apply(code, 'isClipCutaway')) }
  }, be === 'webgpu' ? W.wgsl : W.glsl)
  await p.goto(`${process.env.BASE ?? 'http://localhost:5173/'}v1.html?backend=${be}&rate=${process.env.RATE ?? 1}${process.env.Q ?? ''}`)
  await p.waitForFunction(() => document.getElementById('version').textContent)
  await p.selectOption('#layout', 'render'); await p.selectOption('#ov', process.env.OV ?? '0')
  await p.waitForTimeout(2500)
  await p.evaluate(async () => { nv.azimuth = 110; for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame) })
  const png = await p.locator('#gl1').screenshot()
  const stats = await p.evaluate(async (b64) => {
    const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode()
    const cv = new OffscreenCanvas(i.width, i.height); const x = cv.getContext('2d'); x.drawImage(i, 0, 0)
    const d = x.getImageData(0, 0, i.width, i.height).data
    let n = 0, fine = 0, fast = 0, zeroFine = 0; const hist = new Array(256).fill(0)
    for (let k = 0; k < d.length; k += 4) if (d[k + 2] > 200) { n++; fine += d[k] * 4; fast += d[k + 1] * 4; if (d[k] === 0) zeroFine++; hist[d[k]]++ }
    let acc = 0, p99 = 0, p999 = 0, max = 0
    for (let v = 0; v < 256; v++) { if (hist[v]) max = v * 4; acc += hist[v]; if (!p99 && acc >= 0.99 * n) p99 = v * 4; if (!p999 && acc >= 0.999 * n) p999 = v * 4 }
    return { rayPixels: n, meanFine: +(fine / n).toFixed(1), meanFast: +(fast / n).toFixed(1), noFineHit: zeroFine, totalMsamples: +((fine + fast) / 1e6).toFixed(1), p99Fine: p99, p999Fine: p999, maxFine: max, over200: hist.slice(50).reduce((a, b) => a + b, 0) }
  }, png.toString('base64'))
  console.log(be, 'patched=' + (await p.evaluate(() => window.patched)), JSON.stringify(stats))
  await p.close()
}
await b.close()

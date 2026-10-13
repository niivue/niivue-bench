// Time render/ov0/rotate on WebGPU with runtime WGSL substitutions in fragment_main.
import { chromium } from 'playwright-core'
const EXP = {
  baseline: [],
  discardTop: [['let rayStart = in.vColor;', 'if (params.backOpacity > -1.0) { discard; }\n\tlet rayStart = in.vColor;']],
  noFine: [['for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (var fi: i32 = 0; fi < 1; fi++) {']],
  noPow: [['1.0 - pow(1.0 - colorSample.a, max(slab * refPerLen * params.lodOpacityScale, 1e-3))', 'colorSample.a']],
  noClipLoop: [['clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);', '']],
  noClipAll: [['clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);', ''], ['let cutaway = params.isClipCutaway > 0.5;', 'let cutaway = false;']],
  // Loop still runs, but isClip becomes a compile-time false: isolates the loop's
  // own cost from the per-sample clip branches it keeps alive in the march.
  loopButNoIsClip: [['let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));', 'let isClip = false;']],
  // Only the per-sample clip test in the fine and fast loops removed.
  noSampleClipTest: [['if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {\n\t\t\t\tsamplePos += deltaDirFast;', 'if (false) {\n\t\t\t\tsamplePos += deltaDirFast;'], ['if (cutaway && isClip && samplePos.a >= sampleRange.x && samplePos.a <= sampleRange.y) {\n\t\t\t\t\tsamplePos += deltaDir;', 'if (false) {\n\t\t\t\t\tsamplePos += deltaDir;']],
  breakInactive: [['for (var i: i32 = 0; i < MAX_CLIP_PLANES; i++) {\n\t\tclipSampleRange', 'for (var i: i32 = 0; i < MAX_CLIP_PLANES; i++) {\n\t\tif (abs(params.clipPlanes[i].a) > 1.0) { break; }\n\t\tclipSampleRange']],
  // Pipeline-overridable constant (Dawn substitutes it before MSL codegen).
  overrideClip: [['@fragment\nfn fragment_main', 'override HAS_CLIP: bool = false;\n@fragment\nfn fragment_main'], ['let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));', 'let isClip = HAS_CLIP && ((sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0)));']],
  allConst: [
    ['let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));', 'let isClip = false;'],
    ['let cutaway = params.isClipCutaway > 0.5;', 'let cutaway = false;'],
    ['let chunkedDraw = any(params.chunkSubSize.xyz < vec3f(0.999));', 'let chunkedDraw = false;'],
    ['let overlayMode = params.overlayLayerMode > 0.5;', 'let overlayMode = false;'],
    ['let mip = params.renderMode > 0.5;', 'let mip = false;'],
    ['if (params.cubicFilter > 0.5) {\n\t\t\t\t\tcolorSample', 'if (false) {\n\t\t\t\t\tcolorSample'],
    ['let needsGradient = (localGradientAmount > 0.0) || (params.gradientOpacity > 0.0) || (params.silhouettePower > 0.0);', 'let needsGradient = false;'],
  ],
  allConstNoPow: [],
  ovMipRuntime: [['params.gradientAmount, params.invGamma, mip);', 'params.gradientAmount, params.invGamma, params.renderMode > 0.5);']],
  ovClipRuntime: [['let ovClipMode = select(0.0, select(1.0, 2.0, cutaway), clipOverlay);', 'let ovClipMode = select(select(0.0, select(1.0, 2.0, cutaway), clipOverlay), 1.0, params.clipPlaneOverlay > 1.5);']],
  mipConst: [['let mip = params.renderMode > 0.5;', 'let mip = false;']],
  noLoopConst: [['clipSampleRange(dir, vec4f(start, 0.0), params.clipPlanes[i], &sampleRange, &hasClip);', ''], ['let isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));', 'let isClip = false;']],
  // Simulated split flags: drop the per-sample gradient-opacity / silhouette terms.
  noGradOpSil: [['if (params.gradientOpacity > 0.0) {\n\t\t\t\t\t\tcorrectedA *=', 'if (false) {\n\t\t\t\t\t\tcorrectedA *='], ['if (params.silhouettePower > 0.0) {\n\t\t\t\t\t\tlet viewAlign', 'if (false) {\n\t\t\t\t\t\tlet viewAlign']],
  noLighting: [['if (lightingAmount > 0.0) {', 'if (false) {']],
  noChunkCoord: [['g:chunkTexCoord(samplePos.xyz)', 'samplePos.xyz']],
  noGamma: [['var finalRGB = applyGamma(colorSample.rgb, params.invGamma);', 'var finalRGB = colorSample.rgb;']],
  noStepCorrect: [['stepCorrectAlpha(colorSample.a, max(slab * refPerLen * params.lodOpacityScale, 1e-3))', 'colorSample.a']],
  noFastPass: [['for (var j: i32 = 0; j < 1024; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }', 'for (var j: i32 = 0; j < 0; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }']],
  noEarlyTerm: [['if (colAcc.a > earlyTermination) { break; }', '']],
  dynBounds: [['for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (var fi: i32 = 0; fi < i32(params.numVolumes) * 8192; fi++) {'], ['for (var j: i32 = 0; j < 1024; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }', 'for (var j: i32 = 0; j < i32(params.numVolumes) * 1024; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }']],
  fixed256: [['for (var j: i32 = 0; j < 1024; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }', 'for (var j: i32 = 0; j < 0; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }'], ['for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {\n\t\t\t\tif (bLo >= len) { break; }', 'for (var fi: i32 = 0; fi < 256; fi++) {\n\t\t\t\tif (false) { break; }'], ['if (colAcc.a > earlyTermination) { break; }', '']],
  glFixed256: [['for (int j = 0; j < 1024; j++) {\n      if (samplePos.a > fastLimit) { break; }', 'for (int j = 0; j < 0; j++) {\n      if (samplePos.a > fastLimit) { break; }'], ['for (int fi = 0; fi < MAX_FINE_STEPS; fi++) {\n        if (bLo >= len) { break; }', 'for (int fi = 0; fi < 256; fi++) {\n        if (false) { break; }'], ['if (colAcc.a > localEarlyTermination) { break; }', '']],
  noOverlayTail: [['if (!chunkedDraw) {\n\t\tcolAcc *= params.backOpacity;', 'if (!chunkedDraw) {\n\t\tcolAcc *= params.backOpacity; return FragmentOutput(colAcc, fragDepth);']],
}
EXP.allConstNoPow = [...EXP.allConst, ...EXP.noPow]
for (const n of [4, 16, 64, 256]) {
  EXP['fixed' + n] = EXP.fixed256.map(([a, b]) => [a, b.replace('fi < 256', 'fi < ' + n)])
  EXP['glFixed' + n] = EXP.glFixed256.map(([a, b]) => [a, b.replace('fi < 256', 'fi < ' + n)])
}
EXP.fastOnly = [['for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (var fi: i32 = 0; fi < 0; fi++) {']]
EXP.glFastOnly = [['for (int fi = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (int fi = 0; fi < 0; fi++) {']]
EXP.fastFixed26 = [...EXP.fastOnly, ['for (var j: i32 = 0; j < 1024; j++) {\n\t\t\tif (samplePos.a > fastLimit) { break; }', 'for (var j: i32 = 0; j < 26; j++) {\n\t\t\tif (false) { break; }'], ["let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(samplePos.xyz), 0.0).a;\n\t\t\tif (alpha >= 0.01) {\n\t\t\t\tbreak;\n\t\t\t}", "let alpha = textureSampleLevel(volume, tex_sampler, chunkTexCoord(samplePos.xyz), 0.0).a;"]]
EXP.glFastFixed26 = [...EXP.glFastOnly, ['for (int j = 0; j < 1024; j++) {\n      if (samplePos.a > fastLimit) { break; }', 'for (int j = 0; j < 26; j++) {\n      if (false) { break; }'], ["float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;\n      if (alpha >= 0.01) {\n        break;\n      }", "float alpha = texture(volume, chunkTexCoord(samplePos.xyz)).a;"]]
EXP.divFixed = EXP.fixed256.map(([a, b]) => [a, b.replace('fi < 256', 'fi < 4 + i32(fract(sin(dot(in.vColor.xy, vec2f(12.9898, 78.233))) * 43758.5453) * 24.0)')])
EXP.glDivFixed = EXP.glFixed256.map(([a, b]) => [a, b.replace('fi < 256', 'fi < 4 + int(fract(sin(dot(vColor.xy, vec2(12.9898, 78.233))) * 43758.5453) * 24.0)')])
EXP.etAsFlag = [['if (colAcc.a > earlyTermination) { break; }', 'if (colAcc.a > earlyTermination) { bLo = len; }']]
EXP.noDiscardEnd = [['if (colAcc.a <= 0.001) {\n\t\tdiscard;\n\t}', '']]
EXP.glNoDiscardEnd = [['if (colAcc.a <= 0.001) {\n    discard;\n  }', '']]
EXP.cap64 = [['for (var fi: i32 = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (var fi: i32 = 0; fi < 64; fi++) {']]
EXP.glCap64 = [['for (int fi = 0; fi < MAX_FINE_STEPS; fi++) {', 'for (int fi = 0; fi < 64; fi++) {']]
EXP.stripAll = [...EXP.noChunkCoord, ...EXP.noGamma, ...EXP.noStepCorrect]
const GL = {
  glBaseline: [],
  glDiscardTop: [['vec3 rayStart = vColor', 'if (backOpacity > -1.0) { discard; }\n  vec3 rayStart = vColor']],
  glNoIsClip: [['bool isClip = (sampleRange.x > 0.0) || ((sampleRange.y < len) && (sampleRange.y > 0.0));', 'const bool isClip = false;']],
  glNoPow: [['(1.0 - pow(1.0 - colorSample.a, max(slab * refPerLen * lodOpacityScale, 1e-3)))', 'colorSample.a']],
}
Object.assign(EXP, GL)
EXP.ovBothRuntime = [...EXP.ovMipRuntime, ...EXP.ovClipRuntime]
const dpr = process.env.DPR ?? '2'
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean)] })
for (const name of (process.env.EXPS ?? 'baseline,discardTop,noFine,noPow,noClipLoop,noClipAll,baseline').split(',')) {
  const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  p.on('console', (m) => m.type() === 'error' && console.log('  err', m.text().slice(0, 300)))
  await p.addInitScript((subs) => {
    window.patched = 0
    const os = WebGL2RenderingContext.prototype.shaderSource
    WebGL2RenderingContext.prototype.shaderSource = function (sh, code) {
      if (code.includes('rayMarchPass') && code.includes('isClipCutaway')) {
        for (const [a, b] of subs) {
          if (!code.includes(a)) throw new Error('patch miss: ' + a.slice(0, 60))
          code = code.replace(a, b)
        }
        window.patched++
      }
      return os.call(this, sh, code)
    }
    const o = GPUDevice.prototype.createShaderModule
    GPUDevice.prototype.createShaderModule = function (d) {
      if (d.code.includes('fn fragment_main') && d.code.includes('rayMarchPass')) {
        for (const [a, b] of subs) {
          const all = a.startsWith('g:'); const pat = all ? a.slice(2) : a
          if (!d.code.includes(pat)) throw new Error('patch miss: ' + pat.slice(0, 60))
          d = { ...d, code: all ? d.code.replaceAll(pat, b) : d.code.replace(pat, b) }
        }
        window.patched++
      }
      return o.call(this, d)
    }
  }, EXP[name])
  await p.goto(`${process.env.BASE ?? 'http://localhost:5173/'}v1.html?backend=${name.startsWith('gl') ? 'webgl2' : 'webgpu'}&dpr=${dpr}&frames=40&aa=${process.env.AA ?? 1}`)
  await p.waitForFunction(() => document.getElementById('version').textContent)
  await p.selectOption('#layout', process.env.LAYOUT ?? 'render'); await p.selectOption('#ov', process.env.OV ?? '0'); await p.selectOption('#anim', 'rotate')
  await p.click('#runOne')
  await p.waitForFunction(() => document.querySelectorAll('#results tr').length >= 2, null, { timeout: 120000 })
  const r = await p.$eval('#results tr:nth-child(2)', (tr) => [...tr.cells].map((c) => c.textContent))
  console.log([name.padEnd(14), `patched=${await p.evaluate(() => patched)}`, r[7], `ms=${r[9]}`, `cpu=${r[10]}`].join('\t'))
  if (process.env.SHOT) await p.screenshot({ path: `patch_${name}.png` })
  await p.close()
}
await b.close()

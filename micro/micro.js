const q = new URLSearchParams(location.search)
const num = (k, d) => (q.has(k) ? +q.get(k) : d)
const P = {
  w: num('w', 1800),
  h: num('h', 1400),
  frames: num('frames', 60),
  warmup: num('warmup', 20),
  usage: q.get('usage') ?? 'sampled',
  aa: num('aa', 1) !== 0,
  depth: num('depth', 1) !== 0,
  rate: num('rate', 1),
  loop: num('loop', 4096),
  present: num('present', 1) !== 0, // present=0 renders offscreen (isolates swapchain/compositor cost)
  api: q.get('api'),
  pre: num('pre', 0), // untimed identical passes before the timed one (GPU warm-up probe; WebGL2's timer query includes them)
  spin: num('spin', 0) !== 0, // spin=1 runs an extra empty requestAnimationFrame loop alongside rendering
}
if (P.spin) { const spin = () => requestAnimationFrame(spin); spin() }
const DIM = 256
const STEP = 1 / (256 * P.rate)
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
const span = (a) => (a.length ? [Math.min(...a), median(a), Math.max(...a)].map((x) => +x.toFixed(3)) : null)

// Deterministic spherical-shell volume: alpha 0 beyond r=0.45, ramping inside with radial banding.
function makeVolume() {
  const v = new Uint8Array(DIM * DIM * DIM * 4)
  for (let z = 0, i = 0; z < DIM; z++) {
    const dz = z / (DIM - 1) - 0.5
    for (let y = 0; y < DIM; y++) {
      const dy = y / (DIM - 1) - 0.5
      for (let x = 0; x < DIM; x++, i += 4) {
        const dx = x / (DIM - 1) - 0.5
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const a = r >= 0.45 ? 0 : 0.3 * (1 - r / 0.45) * (0.5 + 0.5 * Math.sin(r * 60))
        v[i] = 40 + 215 * (x / DIM)
        v[i + 1] = 40 + 215 * (y / DIM)
        v[i + 2] = 40 + 215 * (z / DIM)
        v[i + 3] = 255 * a
      }
    }
  }
  return v
}

const wgsl = (loop, depth) => `
struct U { az: f32, aspect: f32, step: f32, pad: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var vol: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
struct FO { @location(0) color: vec4f${depth ? ', @builtin(frag_depth) depth: f32' : ''} };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(q[i], 0.0, 1.0);
  o.uv = q[i];
  return o;
}

@fragment fn fs(v: VO) -> FO {
  let ca = cos(u.az);
  let sa = sin(u.az);
  let rd = normalize(vec3f(sa, 0.15, ca));
  let rt = vec3f(ca, 0.0, -sa);
  let up = normalize(cross(rd, rt));
  let ro = vec3f(0.5) + rt * (v.uv.x * u.aspect * 0.9) + up * (v.uv.y * 0.9) - rd * 1.5;
  let inv = 1.0 / (rd + vec3f(1.0e-6));
  let ta = (vec3f(0.0) - ro) * inv;
  let tb = (vec3f(1.0) - ro) * inv;
  let t0 = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
  let len = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  var acc = vec4f(0.0);
  var zh = -1.0;
  var t = max(t0, 0.0);
  for (var i = 0; i < ${loop}; i = i + 1) {
    if (t > len) { break; }
    let p = ro + rd * t;
    let s = textureSampleLevel(vol, samp, p, 0.0);
    if (s.a > 0.0 && zh < 0.0) { zh = t; }
    acc = acc + vec4f(s.rgb * s.a, s.a) * (1.0 - acc.a);
    if (acc.a > 0.95) { break; }
    t = t + u.step;
  }
  var o: FO;
  o.color = acc;
${depth ? '  o.depth = clamp(zh / 3.0, 0.0, 1.0);\n' : ''}  return o;
}
`

const glslVs = `#version 300 es
out vec2 vUv;
void main() {
  vec2 q = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(q, 0.0, 1.0);
  vUv = q;
}
`

const glslFs = (loop, depth) => `#version 300 es
precision highp float;
precision highp sampler3D;
uniform vec4 u; // az, aspect, step, pad
uniform sampler3D vol;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  float ca = cos(u.x);
  float sa = sin(u.x);
  vec3 rd = normalize(vec3(sa, 0.15, ca));
  vec3 rt = vec3(ca, 0.0, -sa);
  vec3 up = normalize(cross(rd, rt));
  vec3 ro = vec3(0.5) + rt * (vUv.x * u.y * 0.9) + up * (vUv.y * 0.9) - rd * 1.5;
  vec3 inv = 1.0 / (rd + vec3(1.0e-6));
  vec3 ta = (vec3(0.0) - ro) * inv;
  vec3 tb = (vec3(1.0) - ro) * inv;
  float t0 = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
  float len = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  vec4 acc = vec4(0.0);
  float zh = -1.0;
  float t = max(t0, 0.0);
  for (int i = 0; i < ${loop}; i = i + 1) {
    if (t > len) { break; }
    vec3 p = ro + rd * t;
    vec4 s = textureLod(vol, p, 0.0);
    if (s.a > 0.0 && zh < 0.0) { zh = t; }
    acc = acc + vec4(s.rgb * s.a, s.a) * (1.0 - acc.a);
    if (acc.a > 0.95) { break; }
    t = t + u.z;
  }
  fragColor = acc;
${depth ? '  gl_FragDepth = clamp(zh / 3.0, 0.0, 1.0);\n' : ''}}
`

const nextFrame = () => new Promise(requestAnimationFrame)
const azOf = (i) => (i * 0.031) % (Math.PI * 2)

// Fraction of non-black pixels, so an empty render can never masquerade as a fast one.
function stats(bytes, w, h, stride) {
  let lit = 0
  let sum = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * 4
      const m = Math.max(bytes[i], bytes[i + 1], bytes[i + 2])
      if (m > 8) lit++
      sum += m
    }
  const n = w * h
  return { lit: +(lit / n).toFixed(4), mean: +(sum / n).toFixed(2) }
}

async function runWebGL2(vol) {
  const cv = document.getElementById('cv-webgl2')
  cv.width = P.w
  cv.height = P.h
  const gl = cv.getContext('webgl2', { antialias: false, depth: !P.aa, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
  if (!gl) throw new Error('no webgl2')

  const sh = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, glslVs))
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, glslFs(P.loop, P.depth)))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  const uLoc = gl.getUniformLocation(prog, 'u')
  gl.uniform1i(gl.getUniformLocation(prog, 'vol'), 0)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, DIM, DIM, DIM)
  gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, DIM, DIM, DIM, gl.RGBA, gl.UNSIGNED_BYTE, vol)
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
  ])
    gl.texParameteri(gl.TEXTURE_3D, k, v)

  let fbo = null
  if (P.aa) {
    fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    for (const [fmt, att] of [
      [gl.RGBA8, gl.COLOR_ATTACHMENT0],
      [gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT],
    ]) {
      const rb = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, fmt, P.w, P.h)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, att, gl.RENDERBUFFER, rb)
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('msaa fbo incomplete')
  }

  gl.viewport(0, 0, P.w, P.h)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.ALWAYS)
  gl.depthMask(P.depth)
  gl.clearColor(0, 0, 0, 1)
  const px = new Uint8Array(4)
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  const queries = []

  const draw = (az, timed) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    for (let k = 0; k < P.pre; k++) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniform4f(uLoc, az, P.w / P.h, STEP, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    if (timed && tq) {
      queries.push(gl.createQuery())
      gl.beginQuery(tq.TIME_ELAPSED_EXT, queries[queries.length - 1])
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.uniform4f(uLoc, az, P.w / P.h, STEP, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (P.aa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.blitFramebuffer(0, 0, P.w, P.h, 0, 0, P.w, P.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (timed && tq) gl.endQuery(tq.TIME_ELAPSED_EXT)
    gl.readPixels(P.w >> 1, P.h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  }

  const ms = []
  for (let i = 0; i < P.warmup + P.frames; i++) {
    await nextFrame()
    const t0 = performance.now()
    draw(azOf(i), i >= P.warmup)
    const dt = performance.now() - t0
    if (i >= P.warmup) ms.push(dt)
  }
  const gpuMs = []
  if (tq) {
    while (!gl.getQueryParameter(queries[queries.length - 1], gl.QUERY_RESULT_AVAILABLE)) await nextFrame()
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT))
      for (const qq of queries) gpuMs.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6)
  }
  draw(azOf(P.warmup))
  const full = new Uint8Array(P.w * P.h * 4)
  gl.readPixels(0, 0, P.w, P.h, gl.RGBA, gl.UNSIGNED_BYTE, full)
  const r = { api: 'webgl2', ms: +median(ms).toFixed(3) }
  if (gpuMs.length) { r.gpuMs = +median(gpuMs).toFixed(3); r.gpuSpan = span(gpuMs) }
  r.timestampQuery = !!tq
  r.img = stats(full, P.w, P.h, P.w * 4)
  return r
}

async function runWebGPU(vol) {
  const cv = document.getElementById('cv-webgpu')
  cv.width = P.w
  cv.height = P.h
  if (!navigator.gpu) throw new Error('no webgpu')
  window.stage = 'adapter'
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('no adapter')
  const hasTs = adapter.features.has('timestamp-query')
  window.stage = 'device'
  const device = await adapter.requestDevice({ requiredFeatures: hasTs ? ['timestamp-query'] : [] })
  device.addEventListener('uncapturederror', (e) => console.error('wgpu', e.error.message))

  const ctx = cv.getContext('webgpu')
  const format = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })

  const U = { TEXTURE_BINDING: GPUTextureUsage.TEXTURE_BINDING, COPY_DST: GPUTextureUsage.COPY_DST }
  let usage = U.TEXTURE_BINDING | U.COPY_DST
  if (P.usage === 'storage') usage |= GPUTextureUsage.STORAGE_BINDING
  if (P.usage === 'render') usage |= GPUTextureUsage.RENDER_ATTACHMENT
  device.pushErrorScope('validation')
  const tex = device.createTexture({ size: [DIM, DIM, DIM], dimension: '3d', format: 'rgba8unorm', usage })
  const texErr = await device.popErrorScope()
  if (texErr) throw new Error(`texture usage=${P.usage}: ${texErr.message}`)
  device.queue.writeTexture({ texture: tex }, vol, { bytesPerRow: DIM * 4, rowsPerImage: DIM }, [DIM, DIM, DIM])

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const ubo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const module = device.createShaderModule({ code: wgsl(P.loop, P.depth) })
  window.stage = 'compile'
  const info = await module.getCompilationInfo()
  const errs = info.messages.filter((m) => m.type === 'error')
  if (errs.length) throw new Error(errs.map((m) => `${m.lineNum}: ${m.message}`).join('; '))

  const samples = P.aa ? 4 : 1
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      ],
    },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: P.depth, depthCompare: 'always' },
    multisample: { count: samples },
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: ubo } },
      { binding: 1, resource: tex.createView() },
      { binding: 2, resource: sampler },
    ],
  })

  const rt = { size: [P.w, P.h], sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT }
  const offscreen = P.present
    ? null
    : device.createTexture({ size: [P.w, P.h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  const depthView = device.createTexture({ ...rt, format: 'depth24plus' }).createView()
  const msaaView = P.aa ? device.createTexture({ ...rt, format }).createView() : null

  let qs = null
  let resolveBuf = null
  let readBuf = null
  if (hasTs) {
    qs = device.createQuerySet({ type: 'timestamp', count: 2 })
    resolveBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    readBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  }

  const rowBytes = Math.ceil((P.w * 4) / 256) * 256

  const draw = (az, copyTo) => {
    device.queue.writeBuffer(ubo, 0, new Float32Array([az, P.w / P.h, STEP, 0]))
    const enc = device.createCommandEncoder()
    const canvasTex = offscreen ?? ctx.getCurrentTexture()
    const view = canvasTex.createView()
    for (let k = 0; k < P.pre; k++) {
      const pp = enc.beginRenderPass({
        colorAttachments: [{ view: P.aa ? msaaView : view, resolveTarget: P.aa ? view : undefined, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: P.aa ? 'discard' : 'store' }],
        depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      })
      pp.setPipeline(pipeline)
      pp.setBindGroup(0, bind)
      pp.draw(3)
      pp.end()
    }
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: P.aa ? msaaView : view,
          resolveTarget: P.aa ? view : undefined,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: P.aa ? 'discard' : 'store',
        },
      ],
      depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      ...(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.draw(3)
    pass.end()
    if (qs) {
      enc.resolveQuerySet(qs, 0, 2, resolveBuf, 0)
      enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 16)
    }
    if (copyTo) enc.copyTextureToBuffer({ texture: canvasTex }, { buffer: copyTo, bytesPerRow: rowBytes }, [P.w, P.h])
    device.queue.submit([enc.finish()])
  }

  const ms = []
  const gpuMs = []
  for (let i = 0; i < P.warmup + P.frames; i++) {
    window.stage = 'frame ' + i
    await nextFrame()
    const t0 = performance.now()
    draw(azOf(i))
    window.stage = 'submitted ' + i
    await device.queue.onSubmittedWorkDone()
    window.stage = 'done ' + i
    const dt = performance.now() - t0
    if (i >= P.warmup) ms.push(dt)
    if (qs) {
      window.stage = 'map ' + i
      await readBuf.mapAsync(GPUMapMode.READ)
      const t = new BigInt64Array(readBuf.getMappedRange().slice(0))
      readBuf.unmap()
      if (i >= P.warmup) gpuMs.push(Number(t[1] - t[0]) / 1e6)
    }
  }
  const pix = device.createBuffer({ size: rowBytes * P.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  await nextFrame()
  draw(azOf(P.warmup), pix)
  await device.queue.onSubmittedWorkDone()
  if (qs) { await readBuf.mapAsync(GPUMapMode.READ); readBuf.unmap() }
  await pix.mapAsync(GPUMapMode.READ)
  const img = stats(new Uint8Array(pix.getMappedRange()), P.w, P.h, rowBytes)
  pix.unmap()
  const r = { api: 'webgpu', ms: +median(ms).toFixed(3), img }
  if (gpuMs.length) { r.gpuMs = +median(gpuMs).toFixed(3); r.gpuSpan = span(gpuMs) }
  r.timestampQuery = hasTs
  if (q.get('raw')) r.raw = gpuMs.map((x) => +x.toFixed(2))
  return r
}

const out = document.getElementById('out')
const vol = makeVolume()
const results = []
for (const [api, fn] of [
  ['webgl2', runWebGL2],
  ['webgpu', runWebGPU],
]) {
  if (P.api && P.api !== api) continue
  try {
    results.push({ ...(await fn(vol)), w: P.w, h: P.h, usage: P.usage, aa: P.aa, depth: P.depth, rate: P.rate, loop: P.loop })
  } catch (e) {
    results.push({ api, error: String(e.message ?? e) })
  }
  out.textContent = JSON.stringify(results, null, 1)
}
out.textContent = JSON.stringify(results, null, 1)
window.done = results

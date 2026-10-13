// Shared harness: identical canvas, data, scenarios and timing for both APIs.
// Page-level settings (dpr, aa, backend, shade, mod) live in the URL and reload
// the page, so any result is reproducible from its link.
export const P = Object.fromEntries(new URLSearchParams(location.search))
P.dpr = Number(P.dpr ?? 0) // 0 = native window.devicePixelRatio
P.aa = P.aa !== '0'
P.backend ??= 'webgpu'
P.shade = Number(P.shade ?? 0)
P.mod = P.mod !== '0'
// 1 ray sample per voxel matches 0.6x (1.0 defaults to 2). 0.6x ignores it.
P.rate = Number(P.rate ?? 1)
P.frames = Math.max(1, Number(P.frames) || 60)
P.reps = Math.max(1, Number(P.reps) || 3)

// Same tissue maps as mono examples/vox.tissues.html (native 188x256x190 grid).
const TISSUES = [
  { id: 'gm', file: 'chris_t1_gm.nii.gz', tint: [224, 104, 104] },
  { id: 'wm', file: 'chris_t1_wm.nii.gz', tint: [210, 210, 210] },
  { id: 'csf', file: 'chris_t1_csf.nii.gz', tint: [120, 160, 255] },
]
export const colormaps = TISSUES.map(({ id, tint: [r, g, b] }) => [id, {
  R: [Math.round(r * 0.75), r], G: [Math.round(g * 0.75), g], B: [Math.round(b * 0.75), b],
  A: [0, 255], I: [0, 255],
}])
// T1 plus the first `ov` tissue maps; calKeys differ between APIs (cal_min vs calMin).
export const volumeList = (ov, [lo, hi]) => [
  { url: '/volumes/chris_t1.nii.gz', colormap: 'gray' },
  ...TISSUES.slice(0, ov).map((t) => ({
    url: `/volumes/${t.file}`, colormap: t.id, colormapType: 1, [lo]: 0.05, [hi]: 1, opacity: 0.7,
  })),
]

const SUITE = [
  ['multi2d', 0, 'scroll'],
  ['render', 0, 'rotate'],
  ['render', 1, 'rotate'],
  ['multi', 0, 'scroll'],
  ['multi', 1, 'scroll'],
  ['render', 3, 'rotate'],
  ['multi', 3, 'scroll'],
]

const $ = (id) => document.getElementById(id)
const raf = () => new Promise(requestAnimationFrame)
// Runs after the current rendering update (i.e. after the frame is committed).
const afterFrame = () => new Promise((r) => {
  const ch = new MessageChannel()
  ch.port1.onmessage = r
  ch.port2.postMessage(0)
})

function gpuSync(canvas, backend) {
  if (backend === 'webgpu') {
    return canvas.getContext('webgpu').getConfiguration().device.queue.onSubmittedWorkDone()
  }
  // readPixels blocks until the driver has drained every queued command.
  const gl = canvas.getContext('webgl2')
  const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
}

// One frame: t0 at the start of our rAF callback, t1 once the GPU is idle.
// 0.6x draws synchronously, so it steps inside our callback. 1.0 draws from its
// own rAF callback, so it steps first and our callback (registered earlier)
// still runs before its render in the same frame -- no vsync wait is counted.
function frame(a, i, anim) {
  let t0
  const p = raf().then(async () => {
    t0 = performance.now()
    if (a.syncDraw) a.step(i, anim)
    await afterFrame()
    const cpu = performance.now() - t0
    await gpuSync(canvas, a.backend)
    return [performance.now() - t0, cpu]
  })
  if (!a.syncDraw) a.step(i, anim)
  return p
}

const median = (v) => {
  const s = [...v].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Serialize scene changes: a UI change and a run must not load volumes concurrently.
let sceneQueue = Promise.resolve()
let loaded = -1
const setScene = (a, layout, ov) => (sceneQueue = sceneQueue.then(async () => {
  if (ov !== loaded) {
    await a.load(ov)
    loaded = ov
  }
  a.view(layout)
}))

async function measure(a, layout, ov, anim) {
  const t = performance.now()
  await setScene(a, layout, ov)
  const loadMs = performance.now() - t
  // Warm up by time: shader variants may still be compiling in the background.
  for (let i = 0, t0 = performance.now(); i < 10 || performance.now() - t0 < 1500; i++) {
    await frame(a, i, anim)
  }
  const ms = [], cpu = []
  for (let r = 0; r < P.reps; r++) {
    a.view(layout) // same start pose each rep, so scrolling never drifts to an edge
    const f = []
    for (let i = 0; i < P.frames; i++) f.push(await frame(a, i, anim))
    ms.push(median(f.map((x) => x[0])))
    cpu.push(median(f.map((x) => x[1])))
  }
  const row = {
    version: a.version, backend: a.backend, dpr: P.dpr || `auto(${devicePixelRatio})`,
    aa: P.aa, shade: P.shade, mod: P.mod, rate: a.syncDraw ? 1 : P.rate,
    canvas: `${canvas.width}x${canvas.height}`,
    scenario: `${layout}/ov${ov}/${anim}`,
    // 0.6x calls gl.finish() inside drawScene, so its CPU time includes the GPU.
    ms: +median(ms).toFixed(2), cpu: a.syncDraw ? 'n/a' : +median(cpu).toFixed(2),
    fps: Math.round(1000 / median(ms)), load: Math.round(loadMs),
    reps: ms.map((x) => x.toFixed(2)).join(' '),
    ua: navigator.userAgent.match(/(Chrome|Firefox|Version)\/[\d.]+/)?.[0],
    time: new Date().toISOString(),
  }
  const all = JSON.parse(localStorage.nvbench ?? '[]')
  localStorage.nvbench = JSON.stringify([...all, row])
  addRow(row)
  return row
}

function addRow(row) {
  const t = $('results')
  if (!t.rows.length) {
    t.insertRow().append(...Object.keys(row).map((k) => Object.assign(document.createElement('th'), { textContent: k })))
  }
  const tr = t.insertRow()
  for (const v of Object.values(row)) tr.insertCell().textContent = v
}

const UI = `
<header>
  <b id="version"></b>
  <span class="page" title="changing these reloads the page">
    <label>DPR <select id="dpr"><option value="0">auto</option><option>1</option><option>1.5</option><option>2</option></select></label>
    <label>AA <input type="checkbox" id="aa"></label>
    <label id="backendLabel">Backend <select id="backend"><option>webgpu</option><option>webgl2</option></select></label>
    <label title="ray samples per voxel (1.0 only)">Rate <select id="rate"><option>1</option><option>2</option></select></label>
    <label>Shade <select id="shade"><option>0</option><option>0.4</option><option>1</option></select></label>
    <label title="overlays alpha-modulate themselves">SelfMod <input type="checkbox" id="mod"></label>
    <label>Frames <input id="frames" type="number" min="10" style="width:4em"></label>
    <label>Reps <input id="reps" type="number" min="1" style="width:3em"></label>
  </span>
  <span>
    <select id="layout"><option value="multi">A+C+S+R</option><option value="multi2d">A+C+S</option><option value="render">Render</option><option value="axial">Axial</option></select>
    <label>Overlays <select id="ov"><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
    <select id="anim"><option>scroll</option><option>rotate</option></select>
    <button id="animate">Animate</button>
    <button id="runOne">Run</button>
    <button id="runSuite">Run suite</button>
    <a href="/" target="_blank">compare</a>
  </span>
</header>
<div id="box"><canvas id="gl1"></canvas></div>
<table id="results"></table>`
document.body.innerHTML = UI
const canvas = $('gl1')
// Page-level settings: changing one reloads the page with it in the URL.
const SELECTS = ['dpr', 'backend', 'rate', 'shade', 'frames', 'reps']
const CHECKS = ['aa', 'mod']

// Exposed for automation (see gputime3.mjs in the session scratchpad).
window.bench = { measure, frame, setScene }

export async function run(a) {
  window.nvAdapter = a
  document.title = `bench ${a.version}`
  $('backendLabel').hidden = !a.hasBackends
  const reload = () => {
    const q = new URLSearchParams()
    for (const k of SELECTS) q.set(k, $(k).value)
    for (const k of CHECKS) q.set(k, $(k).checked ? 1 : 0)
    location.search = q
  }
  for (const k of SELECTS) {
    $(k).value = P[k]
    $(k).onchange = reload
  }
  for (const k of CHECKS) {
    $(k).checked = P[k]
    $(k).onchange = reload
  }
  await a.init(canvas)
  const view = () => setScene(a, $('layout').value, Number($('ov').value))
  $('layout').onchange = view
  $('ov').onchange = view
  await view()
  let spinning = false
  $('animate').onclick = async () => {
    spinning = !spinning
    for (let i = 0; spinning; i++) await frame(a, i, $('anim').value)
  }
  const controls = document.querySelectorAll('header select, header input, header button')
  let running = false
  const busy = async (fn) => {
    if (running) return
    running = true
    spinning = false
    for (const c of controls) c.disabled = true
    try { await fn() } finally {
      for (const c of controls) c.disabled = false
      running = false
    }
  }
  $('runOne').onclick = () => busy(() => measure(a, $('layout').value, Number($('ov').value), $('anim').value))
  $('runSuite').onclick = () => busy(async () => { for (const s of SUITE) await measure(a, ...s) })
  $('version').textContent = `${a.version} (${a.backend})`
  if (P.auto) $('runSuite').onclick()
}

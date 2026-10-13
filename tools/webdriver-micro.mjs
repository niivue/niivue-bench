// Drive a system browser over WebDriver and run micro/ with and without pointer movement.
// Safari: `safaridriver -p 4444` (needs "Allow remote automation"). Firefox: `geckodriver -p 4444`.
// Usage: BROWSER=safari|firefox bun tools/webdriver-micro.mjs [webgpu|webgl2] [0|1]
const [api = 'webgpu', hover = '0'] = process.argv.slice(2)
const base = `http://localhost:${process.env.PORT ?? 4444}`
const browser = process.env.BROWSER ?? 'safari'
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const j = await r.json()
  if (j.value?.error) throw new Error(`${path}: ${j.value.message}`)
  return j.value
}
const { sessionId } = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: browser } } })
const s = `/session/${sessionId}`
try {
  await call('POST', `${s}/window/rect`, { width: 1200, height: 800 })
  await call('POST', `${s}/url`, { url: `http://localhost:5173/micro/index.html?api=${api}&w=1800&h=1400&warmup=60&frames=800${process.env.EXTRA ?? ""}` })
  // A background window is throttled (Firefox presents WebGPU frames at ~5 Hz), so bring it forward.
  Bun.spawnSync(['osascript', '-e', `tell application "${browser === 'safari' ? 'Safari' : 'Firefox'}" to activate`])
  const exec = (script) => call('POST', `${s}/execute/sync`, { script, args: [] })
  let x = 0
  for (;;) {
    if (await exec('return !!window.done')) break
    if (hover === '1') {
      x = (x + 8) % 500
      await call('POST', `${s}/actions`, { actions: [{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: 100 + x, y: 300, duration: 8 }] }] })
    } else await new Promise((r) => setTimeout(r, 50))
  }
  const done = await exec('return window.done')
  console.log(browser, api, hover === '1' ? 'hover' : 'idle ', JSON.stringify(done.map((d) => ({ ms: d.ms, gpuMs: d.gpuMs }))))
} finally {
  await call('DELETE', s)
}

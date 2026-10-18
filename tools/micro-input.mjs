// Standalone microbench with (or without) real pointer movement over its canvas.
import { chromium } from 'playwright-core'
const [api = 'webgpu', hover = '1', extra = ''] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', ...(process.env.VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']), '--enable-dawn-features=allow_unsafe_apis', ...(process.env.CHROME_ARGS?.split(' ').filter(Boolean) ?? [])] })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.goto(`http://localhost:5173/micro/index.html?api=${api}&w=1800&h=1400&warmup=60&frames=800&raw=1${extra}`)
const box = await p.locator(`#cv-${api}`).boundingBox()
let x = 0, down = false
const t0 = Date.now()
while (!(await p.evaluate(() => window.done))) {
  if (hover === '1') { x = (x + 6) % 400; await p.mouse.move(box.x + 20 + x, box.y + 100) }
  if (hover === 'off') { x = (x + 6) % 400; await p.mouse.move(700 + x, 30) } // over the page text, not the canvas
  if (hover === 'drag') { if (!down) { await p.mouse.down(); down = true } x = (x + 6) % 400; await p.mouse.move(box.x + 20 + x, box.y + 100) }
  if (hover === 'wheel') { x = (x + 6) % 400; await p.mouse.move(box.x + 20, box.y + 100); await p.mouse.wheel(0, x % 12 < 6 ? 40 : -40) }
  if (hover === 'half') { x = (x + 6) % 400; if (Date.now() - t0 < 2500) await p.mouse.move(box.x + 20 + x, box.y + 100) }
  await p.waitForTimeout(8)
}
const r = await p.evaluate(() => window.done)
if (r[0].raw) { const v = r[0].raw; const med = (a) => +[...a].sort((p, q) => p - q)[a.length >> 1].toFixed(2); console.log('  100-frame gpu medians:', Array.from({ length: Math.floor(v.length / 100) }, (_, i) => med(v.slice(i * 100, i * 100 + 100)))) }
console.log(api, ({ 1: 'hover', off: 'hover off-canvas', half: 'hover first 2.5s', drag: 'drag', wheel: 'wheel' }[hover] ?? 'idle '), extra, JSON.stringify(r.map((d) => ({ ms: d.ms, gpuMs: d.gpuMs }))))
await b.close()

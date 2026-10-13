import { chromium } from 'playwright-core'
const [, , path, headless = '1'] = process.argv
const b = await chromium.launch({ channel: 'chrome', headless: headless === '1', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const p = await b.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 })
if (process.env.ALPHA) await p.addInitScript((alpha) => {
  const c = GPUCanvasContext.prototype.configure
  GPUCanvasContext.prototype.configure = function (d) { return c.call(this, { ...d, alphaMode: alpha }) }
}, process.env.ALPHA)
p.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('console.' + m.type(), m.text().slice(0, 300)))
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.goto((process.env.BASE ?? 'http://localhost:5173/') + path)
await p.waitForFunction(() => document.querySelectorAll('#results tr').length >= 8, null, { timeout: 600000 })
console.log(await p.$eval('#results', (t) => [...t.rows].map((r) => [...r.cells].slice(0, 12).map((c) => c.textContent).join('\t')).join('\n')))
await p.screenshot({ path: path.replace(/\W/g, '_') + '.png' })
await b.close()

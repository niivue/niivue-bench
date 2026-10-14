import { readFileSync, statSync } from 'node:fs'

const version = (p) => JSON.parse(readFileSync(`node_modules/${p}/package.json`)).version
const local = process.env.NV1_DIST

export default {
  define: { __NV06__: JSON.stringify(version('nv06')), __NV1__: JSON.stringify(local ? `local ${statSync(local).mtime.toISOString().slice(5, 16)}` : version('nv1')) },
  // nv1/viewport: the NVCanvasViewportController subpath (local builds only)
  resolve: { alias: local ? [{ find: /^nv1\/viewport$/, replacement: local.replace(/niivue\.js$/, 'viewport.js') }, { find: /^nv1$/, replacement: local }] : [] },
}

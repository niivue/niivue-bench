import { readFileSync, statSync } from 'node:fs'

const version = (p) => JSON.parse(readFileSync(`node_modules/${p}/package.json`)).version
const local = process.env.NV1_DIST

export default {
  define: { __NV06__: JSON.stringify(version('nv06')), __NV1__: JSON.stringify(local ? `local ${statSync(local).mtime.toISOString().slice(5, 16)}` : version('nv1')) },
  resolve: { alias: local ? { nv1: local } : {} },
}

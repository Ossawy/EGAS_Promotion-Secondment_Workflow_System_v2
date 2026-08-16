import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const serviceRoot = fileURLToPath(new URL('../', import.meta.url))
const compiler = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
  cwd: serviceRoot,
  stdio: 'inherit'
})
if (result.status !== 0) process.exit(result.status ?? 1)
await import('./copy-assets.mjs')
await import('../dist/server.js')

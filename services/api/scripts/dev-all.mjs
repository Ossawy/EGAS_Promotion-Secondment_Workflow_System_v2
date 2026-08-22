import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apiRoot, assertPortAvailable, repositoryRoot } from './local-dev-lib.mjs'
import { printDevChecks, runDevChecks } from './dev-check.mjs'

function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already stopped */ }
  }
}

export async function runAll() {
  const readiness = await runDevChecks({ ports: false })
  if (readiness.some(check => !check.ok)) {
    printDevChecks(readiness)
    throw new Error('Local environment is not ready. Run npm run dev:setup.')
  }
  await assertPortAvailable(4004)
  await assertPortAvailable(5173)
  const shared = { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' }
  const api = spawn(process.execPath, ['--watch', '--watch-path=src', 'scripts/dev.mjs'], { ...shared, cwd: apiRoot })
  const webRoot = path.join(repositoryRoot, 'apps', 'web')
  const viteCandidates = [
    path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  ]
  const viteCli = viteCandidates.find(candidate => existsSync(candidate))
  if (!viteCli) throw new Error('Vite is not installed. Run npm ci.')
  const web = spawn(process.execPath, [viteCli], { ...shared, cwd: webRoot })
  let stopping = false
  const stop = exitCode => {
    if (stopping) return
    stopping = true
    stopTree(api)
    stopTree(web)
    process.exitCode = exitCode
  }
  process.once('SIGINT', () => stop(0))
  process.once('SIGTERM', () => stop(0))
  api.once('error', error => { console.error(`API failed to start: ${error.message}`); stop(1) })
  web.once('error', error => { console.error(`Frontend failed to start: ${error.message}`); stop(1) })
  api.once('exit', code => { if (!stopping) { console.error(`API stopped with code ${code ?? 1}; stopping frontend.`); stop(code ?? 1) } })
  web.once('exit', code => { if (!stopping) { console.error(`Frontend stopped with code ${code ?? 1}; stopping API.`); stop(code ?? 1) } })
  await Promise.all([
    new Promise(resolve => api.once('close', resolve)),
    new Promise(resolve => web.once('close', resolve))
  ])
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAll().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}

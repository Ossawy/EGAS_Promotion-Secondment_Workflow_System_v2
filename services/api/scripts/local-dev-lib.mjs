import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

export const apiRoot = fileURLToPath(new URL('../', import.meta.url))
export const repositoryRoot = path.resolve(apiRoot, '..', '..')
export const localRoot = path.join(repositoryRoot, '.egas-local')
export const localMarkerFile = path.join(localRoot, 'setup.json')
export const migrationEnvFile = path.join(localRoot, 'migration.env')
export const accountsFile = path.join(localRoot, 'DEV_ACCOUNTS.txt')
export const workbookDirectory = path.join(localRoot, 'generated')
export const signatureDirectory = path.join(localRoot, 'storage', 'signatures')
export const pdfDirectory = path.join(localRoot, 'storage', 'generated-pdfs')
export const apiEnvFile = path.join(apiRoot, '.env')

export const LOCAL_DATABASE = 'egas_workflow_dev'
export const LOCAL_OWNER = 'egas_dev_owner'
export const LOCAL_RUNTIME = 'egas_dev_app'
export const LOCAL_SETUP_VERSION = 1
export const MINIMUM_POSTGRES_VERSION = 140000

export function assertSupportedNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  if (!Number.isInteger(major) || major < 22) throw new Error('Node.js 22 or newer is required')
  return major
}

export function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).trim().toLowerCase())
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function parseEnvText(text) {
  const result = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`Invalid environment key ${key}`)
    if (rawValue.startsWith('"')) {
      try { result[key] = JSON.parse(rawValue) } catch { throw new Error(`Invalid quoted value for ${key}`) }
    } else {
      result[key] = rawValue
    }
  }
  return result
}

export function formatEnv(values, header) {
  const lines = [`# ${header}`, '# Generated for this machine only. Never commit this file.']
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${JSON.stringify(String(value))}`)
  return `${lines.join('\n')}\n`
}

export async function readEnvFile(file) {
  return parseEnvText(await readFile(file, 'utf8'))
}

export async function exists(file) {
  try { await access(file); return true } catch { return false }
}

export async function writeExclusive(file, content, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode })
}

export async function ensureLocalDirectories() {
  for (const directory of [localRoot, workbookDirectory, signatureDirectory, pdfDirectory]) {
    await mkdir(directory, { recursive: true })
  }
}

export function localConnectionFromEnv(env, role) {
  const prefix = role === 'owner' ? 'EGAS_MIGRATION' : 'EGAS_DB'
  const host = env[`${prefix}_HOST`]
  const port = Number(env[`${prefix}_PORT`])
  const database = env[`${prefix}_NAME`]
  const user = env[`${prefix}_USER`]
  const password = env[`${prefix}_PASSWORD`]
  if (!host || !Number.isInteger(port) || !database || !user || !password) {
    throw new Error(`${role} local database configuration is incomplete`)
  }
  if (!isLocalHost(host) || database !== LOCAL_DATABASE) {
    throw new Error(`Refusing non-local or unexpected database target ${host}/${database}`)
  }
  const expectedUser = role === 'owner' ? LOCAL_OWNER : LOCAL_RUNTIME
  if (user !== expectedUser) throw new Error(`Expected ${role} database role ${expectedUser}, found ${user}`)
  return { host, port, database, user, password, ssl: false, connectionTimeoutMillis: 5000 }
}

export async function loadLocalState() {
  if (!await exists(localMarkerFile) || !await exists(migrationEnvFile) || !await exists(apiEnvFile)) return null
  const marker = JSON.parse(await readFile(localMarkerFile, 'utf8'))
  if (marker.version !== LOCAL_SETUP_VERSION || marker.database !== LOCAL_DATABASE) {
    throw new Error('Local setup marker is unsupported or targets an unexpected database')
  }
  const migration = await readEnvFile(migrationEnvFile)
  const runtime = await readEnvFile(apiEnvFile)
  return {
    marker,
    migration,
    runtime,
    ownerConnection: localConnectionFromEnv(migration, 'owner'),
    runtimeConnection: localConnectionFromEnv(runtime, 'runtime')
  }
}

export async function assertDependenciesInstalled() {
  for (const dependency of ['pg', 'argon2', 'exceljs', 'typescript']) {
    const packageFile = path.join(repositoryRoot, 'node_modules', dependency, 'package.json')
    if (!await exists(packageFile)) throw new Error(`Dependency ${dependency} is missing. Run npm ci first.`)
  }
}

export async function verifyPostgres(pool) {
  const result = await pool.query('SELECT current_database() AS database, current_user AS username, current_setting(\'server_version_num\')::integer AS version')
  const row = result.rows[0]
  if (!row || Number(row.version) < MINIMUM_POSTGRES_VERSION) {
    throw new Error(`PostgreSQL 14 or newer is required (reported ${row?.version ?? 'unknown'})`)
  }
  return { database: row.database, username: row.username, version: Number(row.version) }
}

export async function withPool(config, action) {
  const pool = new Pool(config)
  try { return await action(pool) } finally { await pool.end() }
}

export function quoteFixedIdentifier(identifier) {
  if (![LOCAL_DATABASE, LOCAL_OWNER, LOCAL_RUNTIME].includes(identifier)) throw new Error('Unsafe local identifier')
  return `"${identifier}"`
}

export function quoteGeneratedPassword(password) {
  if (!/^[A-Za-z0-9_-]{32,200}$/u.test(password)) throw new Error('Generated PostgreSQL password has an unsafe format')
  return `'${password}'`
}

async function probePort(port, host) {
  return await new Promise(resolve => {
    const server = net.createServer()
    server.unref()
    server.once('error', error => resolve({ available: false, error, host }))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve({ available: true, host })))
  })
}

export async function checkPort(port) {
  const ipv6 = await probePort(port, '::')
  if (!ipv6.available && ipv6.error?.code === 'EAFNOSUPPORT') return await probePort(port, '127.0.0.1')
  return ipv6
}

export async function assertPortAvailable(port) {
  const result = await checkPort(port)
  if (!result.available) throw new Error(`Port ${port} is already in use. Stop that process before starting EGAS.`)
}

export async function verifyWritableDirectory(directory) {
  await mkdir(directory, { recursive: true })
  const probe = path.join(directory, `.egas-write-test-${process.pid}-${Date.now()}`)
  await writeFile(probe, 'local write probe', { flag: 'wx' })
  await unlink(probe)
}

export async function readHiddenLine(prompt) {
  if (process.env.EGAS_DEV_ADMIN_PASSWORD) return process.env.EGAS_DEV_ADMIN_PASSWORD
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('PostgreSQL administrative password is required. Set EGAS_DEV_ADMIN_PASSWORD for non-interactive setup.')
  }
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  return await new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u0003') {
          process.stdin.off('data', onData)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          reject(new Error('Setup cancelled'))
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

export async function promptLine(prompt, fallback) {
  const envKey = {
    'PostgreSQL host': 'EGAS_DEV_ADMIN_HOST',
    'PostgreSQL port': 'EGAS_DEV_ADMIN_PORT',
    'PostgreSQL administrative user': 'EGAS_DEV_ADMIN_USER',
    'PostgreSQL maintenance database': 'EGAS_DEV_ADMIN_DATABASE'
  }[prompt]
  if (envKey && process.env[envKey]) return process.env[envKey]
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback
  const { createInterface } = await import('node:readline/promises')
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const value = (await terminal.question(`${prompt} [${fallback}]: `)).trim()
    return value || fallback
  } finally { terminal.close() }
}

export function normalizePortablePath(value) {
  return path.resolve(value).replaceAll('\\', '/')
}

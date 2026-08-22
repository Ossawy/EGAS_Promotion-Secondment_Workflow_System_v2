import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import {
  LOCAL_DATABASE,
  LOCAL_OWNER,
  LOCAL_RUNTIME,
  LOCAL_SETUP_VERSION,
  MINIMUM_POSTGRES_VERSION,
  accountsFile,
  apiEnvFile,
  assertDependenciesInstalled,
  assertSupportedNode,
  ensureLocalDirectories,
  exists,
  formatEnv,
  isLocalHost,
  loadLocalState,
  localMarkerFile,
  migrationEnvFile,
  normalizePortablePath,
  pdfDirectory,
  promptLine,
  quoteFixedIdentifier,
  quoteGeneratedPassword,
  randomSecret,
  readHiddenLine,
  signatureDirectory,
  verifyPostgres,
  writeExclusive
} from './local-dev-lib.mjs'
import { runLocalMigrations } from './dev-migrate.mjs'
import { runLocalSeed } from './dev-seed.mjs'

async function adminConnectionInput() {
  const host = await promptLine('PostgreSQL host', '127.0.0.1')
  const port = Number(await promptLine('PostgreSQL port', '5432'))
  const user = await promptLine('PostgreSQL administrative user', 'postgres')
  const database = await promptLine('PostgreSQL maintenance database', 'postgres')
  const password = await readHiddenLine(`Password for PostgreSQL role ${user}: `)
  if (!isLocalHost(host)) throw new Error('dev:setup only provisions PostgreSQL on localhost')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PostgreSQL port is invalid')
  if (!user || !database || !password) throw new Error('PostgreSQL administrative connection is incomplete')
  return { host, port, user, database, password, ssl: false, connectionTimeoutMillis: 5000 }
}

async function inspectProvisioning(adminPool) {
  const server = await verifyPostgres(adminPool)
  if (server.version < MINIMUM_POSTGRES_VERSION) throw new Error('PostgreSQL 14 or newer is required')
  const privileges = await adminPool.query(`SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user`)
  const role = privileges.rows[0]
  if (!role || (!role.rolsuper && (!role.rolcreaterole || !role.rolcreatedb))) {
    throw new Error('The administrative role needs CREATEROLE and CREATEDB (or superuser) for first setup')
  }
  const roles = await adminPool.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`, [[LOCAL_OWNER, LOCAL_RUNTIME]])
  const database = await adminPool.query(`SELECT d.datname,r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1`, [LOCAL_DATABASE])
  return { roles: new Set(roles.rows.map(row => row.rolname)), database: database.rows[0] ?? null }
}

async function provision(adminConfig, ownerPassword, runtimePassword, { fresh }) {
  const pool = new Pool(adminConfig)
  try {
    const current = await inspectProvisioning(pool)
    if (fresh && (current.roles.size > 0 || current.database)) {
      throw new Error(`Refusing to adopt or alter existing ${LOCAL_DATABASE}/${LOCAL_OWNER}/${LOCAL_RUNTIME}. Remove them explicitly or choose a clean PostgreSQL instance.`)
    }
    if (current.database && current.database.owner !== LOCAL_OWNER) {
      throw new Error(`${LOCAL_DATABASE} exists but is not owned by ${LOCAL_OWNER}`)
    }
    if (!current.roles.has(LOCAL_OWNER)) {
      await pool.query(`CREATE ROLE ${quoteFixedIdentifier(LOCAL_OWNER)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteGeneratedPassword(ownerPassword)}`)
    }
    if (!current.roles.has(LOCAL_RUNTIME)) {
      await pool.query(`CREATE ROLE ${quoteFixedIdentifier(LOCAL_RUNTIME)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteGeneratedPassword(runtimePassword)}`)
    }
    if (!current.database) {
      await pool.query(`CREATE DATABASE ${quoteFixedIdentifier(LOCAL_DATABASE)} OWNER ${quoteFixedIdentifier(LOCAL_OWNER)} ENCODING 'UTF8' TEMPLATE template0`)
    }
    await pool.query(`REVOKE CONNECT ON DATABASE ${quoteFixedIdentifier(LOCAL_DATABASE)} FROM PUBLIC`)
    await pool.query(`GRANT CONNECT ON DATABASE ${quoteFixedIdentifier(LOCAL_DATABASE)} TO ${quoteFixedIdentifier(LOCAL_OWNER)}, ${quoteFixedIdentifier(LOCAL_RUNTIME)}`)
  } finally { await pool.end() }
}

async function createLocalFiles(adminHost, adminPort) {
  const ownerPassword = randomSecret(36)
  const runtimePassword = randomSecret(36)
  const fingerprintSecret = randomSecret(48)
  const snapshotYear = Number(process.env.EGAS_DEV_SNAPSHOT_YEAR ?? new Date().getUTCFullYear())
  if (!Number.isInteger(snapshotYear) || snapshotYear < 2000 || snapshotYear > 2200) throw new Error('EGAS_DEV_SNAPSHOT_YEAR must be between 2000 and 2200')
  await ensureLocalDirectories()
  await writeExclusive(migrationEnvFile, formatEnv({
    EGAS_MIGRATION_HOST: adminHost,
    EGAS_MIGRATION_PORT: adminPort,
    EGAS_MIGRATION_NAME: LOCAL_DATABASE,
    EGAS_MIGRATION_USER: LOCAL_OWNER,
    EGAS_MIGRATION_PASSWORD: ownerPassword
  }, 'Dedicated local migration-owner connection. Never use this file to run the API.'))
  await writeExclusive(apiEnvFile, formatEnv({
    NODE_ENV: 'development',
    EGAS_PORT: '4004',
    EGAS_DB_HOST: adminHost,
    EGAS_DB_PORT: adminPort,
    EGAS_DB_NAME: LOCAL_DATABASE,
    EGAS_DB_USER: LOCAL_RUNTIME,
    EGAS_DB_PASSWORD: runtimePassword,
    EGAS_DB_SSL: 'false',
    EGAS_DB_SSL_REJECT_UNAUTHORIZED: 'true',
    EGAS_SESSION_COOKIE_NAME: 'EGAS_SESSION',
    EGAS_SESSION_IDLE_MINUTES: '30',
    EGAS_SESSION_ABSOLUTE_HOURS: '8',
    EGAS_REQUIRE_SECURE_COOKIE: 'false',
    EGAS_AUTH_FINGERPRINT_SECRET: fingerprintSecret,
    EGAS_LOGIN_WINDOW_MINUTES: '10',
    EGAS_LOGIN_FAILURE_LIMIT: '5',
    EGAS_LOGIN_LOCKOUT_MINUTES: '15',
    EGAS_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
    EGAS_SIGNATURE_STORAGE_DIR: normalizePortablePath(signatureDirectory),
    EGAS_SIGNATURE_MAX_UPLOAD_BYTES: '1048576',
    EGAS_SIGNATURE_MAX_WIDTH_PIXELS: '2048',
    EGAS_SIGNATURE_MAX_HEIGHT_PIXELS: '2048',
    EGAS_SIGNATURE_MAX_PIXELS: '4000000',
    EGAS_PDF_STORAGE_DIR: normalizePortablePath(pdfDirectory),
    EGAS_PDF_MAX_CONCURRENT_RENDERS: '2',
    EGAS_PDF_MAX_QUEUED_RENDERS: '20',
    EGAS_PDF_RENDER_TIMEOUT_MS: '15000',
    EGAS_PDF_MAX_OUTPUT_BYTES: '20971520',
    EGAS_ACTIVE_SNAPSHOT_YEAR: snapshotYear
  }, 'Restricted EGAS local application runtime configuration.'))
  const marker = {
    version: LOCAL_SETUP_VERSION,
    kind: 'EGAS_LOCAL_DEVELOPMENT',
    database: LOCAL_DATABASE,
    ownerRole: LOCAL_OWNER,
    runtimeRole: LOCAL_RUNTIME,
    status: 'provisioning',
    createdAt: new Date().toISOString()
  }
  await writeExclusive(localMarkerFile, `${JSON.stringify(marker, null, 2)}\n`)
  return { ownerPassword, runtimePassword, marker }
}

async function completeMarker(marker) {
  await writeFile(localMarkerFile, `${JSON.stringify({ ...marker, status: 'ready' }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function firstSetup() {
  for (const protectedFile of [apiEnvFile, migrationEnvFile, localMarkerFile, accountsFile]) {
    if (await exists(protectedFile)) {
      throw new Error(`Existing local artifact ${protectedFile} will not be overwritten. Validate or remove it explicitly before first setup.`)
    }
  }
  const adminConfig = await adminConnectionInput()
  const probe = new Pool(adminConfig)
  try {
    const current = await inspectProvisioning(probe)
    if (current.roles.size > 0 || current.database) {
      throw new Error(`Standard local database or roles already exist without this repository's setup marker. Refusing to rotate or adopt credentials.`)
    }
  } finally { await probe.end() }
  const generated = await createLocalFiles(adminConfig.host, adminConfig.port)
  await provision(adminConfig, generated.ownerPassword, generated.runtimePassword, { fresh: true })
  await completeMarker(generated.marker)
  return { reused: false }
}

async function existingSetup(state) {
  if (state.marker.status !== 'ready') {
    let provisioned = false
    const ownerProbe = new Pool(state.ownerConnection)
    const runtimeProbe = new Pool(state.runtimeConnection)
    try {
      const [owner, runtime] = await Promise.all([verifyPostgres(ownerProbe), verifyPostgres(runtimeProbe)])
      provisioned = owner.username === LOCAL_OWNER && runtime.username === LOCAL_RUNTIME
    } catch { /* an incomplete first run genuinely needs the admin connection again */ }
    finally { await Promise.all([ownerProbe.end(), runtimeProbe.end()]) }
    if (!provisioned) {
      const adminConfig = await adminConnectionInput()
      await provision(adminConfig, state.ownerConnection.password, state.runtimeConnection.password, { fresh: false })
      const ownerVerification = new Pool(state.ownerConnection)
      const runtimeVerification = new Pool(state.runtimeConnection)
      try {
        const [owner, runtime] = await Promise.all([verifyPostgres(ownerVerification), verifyPostgres(runtimeVerification)])
        if (owner.username !== LOCAL_OWNER || runtime.username !== LOCAL_RUNTIME) throw new Error('Local role repair did not produce the expected separated connections')
      } finally { await Promise.all([ownerVerification.end(), runtimeVerification.end()]) }
    }
    await completeMarker(state.marker)
  }
  return { reused: true }
}

export async function runDevSetup() {
  assertSupportedNode()
  await assertDependenciesInstalled()
  const state = await loadLocalState()
  const setup = state ? await existingSetup(state) : await firstSetup()
  const migrations = await runLocalMigrations()
  const seed = await runLocalSeed()
  return { setup, migrations, seed }
}

runDevSetup().then(result => {
  const applied = result.migrations.filter(item => item.result === 'applied').length
  if (result.setup.reused) console.info('Existing EGAS local environment is valid and was reused; no credentials were rotated.')
  else console.info('New EGAS local PostgreSQL database and separated owner/runtime roles created.')
  console.info(`Migrations: ${result.migrations.length} current (${applied} newly applied).`)
  console.info(result.seed.snapshot.reused ? 'Existing active synthetic annual snapshot reused.' : 'Synthetic annual workbook imported and activated through the application pipeline.')
  console.info(`Synthetic login credentials: ${accountsFile}`)
  console.info('Run npm run dev:check, then npm run dev:all.')
}).catch(error => {
  console.error(`Local setup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

import { randomUUID } from 'node:crypto'
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import { LocalAuthenticationProvider } from './local-authentication-provider.ts'
import {
  type DisconnectableDatabase,
  withStandaloneDatabase
} from '../runtime/standalone-database-lifecycle.ts'

type BootstrapInput = {
  username: string
  displayName: string
  temporaryPassword: string
  staffIdentifier: string | null
  jobTitle: string | null
}

type BootstrapDatabase = Service & DisconnectableDatabase

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || value.startsWith('<')) {
    throw new Error(`${name} must be supplied through machine-local environment configuration`)
  }
  return value
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim()
  if (!value || value.startsWith('<')) return null
  return value
}

function readBootstrapInput(): BootstrapInput {
  const username = required('EGAS_BOOTSTRAP_ADMIN_USERNAME')
  const displayName = required('EGAS_BOOTSTRAP_ADMIN_DISPLAY_NAME')
  const temporaryPassword = required('EGAS_BOOTSTRAP_ADMIN_TEMP_PASSWORD')
  const staffIdentifier = optional('EGAS_BOOTSTRAP_ADMIN_STAFF_IDENTIFIER')
  const jobTitle = optional('EGAS_BOOTSTRAP_ADMIN_JOB_TITLE')

  if (!/^[\p{L}\p{N}._@-]{3,120}$/u.test(username)) {
    throw new Error('Bootstrap username must be 3-120 letters, digits, or . _ @ -')
  }
  if (displayName.length > 300) throw new Error('Bootstrap display name exceeds 300 characters')
  if (temporaryPassword.length < 14 || temporaryPassword.length > 256) {
    throw new Error('Temporary password must be between 14 and 256 characters')
  }

  return { username, displayName, temporaryPassword, staffIdentifier, jobTitle }
}

async function bootstrap(db: Service, input: BootstrapInput): Promise<void> {
  const { username, displayName, temporaryPassword, staffIdentifier, jobTitle } = input
  const auth = new LocalAuthenticationProvider(db)
  const passwordHash = await auth.hashPassword(temporaryPassword)

  await db.tx(async tx => {
    // Serialize concurrent bootstrap processes without creating a permanent lock row.
    await tx.run("SELECT pg_advisory_xact_lock(hashtext('egas.bootstrap.admin'))")
    const existingPrivilegedAdmin = await tx.run(
      SELECT.one.from('egas.UserAccountRole')
        .columns('ID')
        .where({ role: 'ADMIN', canManageAdmins: true, isActive: true })
    )

    if (existingPrivilegedAdmin) {
      throw new Error('Bootstrap refused: an active Manage-Admins assignment already exists')
    }

    const duplicateUsername = await tx.run(
      SELECT.one.from('egas.UserAccount').columns('ID').where({ username })
    )
    if (duplicateUsername) throw new Error('Bootstrap refused: username already exists')

    const userId = randomUUID()
    await tx.run(INSERT.into('egas.UserAccount').entries({
      ID: userId,
      username,
      staffIdentifier,
      displayName,
      jobTitle,
      passwordHash,
      mustChangePassword: true,
      isActive: true,
      failedLoginCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    }))

    await tx.run(INSERT.into('egas.UserAccountRole').entries({
      ID: randomUUID(),
      user_ID: userId,
      role: 'ADMIN',
      canManageAdmins: true,
      isActive: true,
      grantedAt: new Date().toISOString()
    }))
  })

  console.info(`Bootstrap Admin created for username ${username}. Password change is mandatory.`)
}

async function main(): Promise<void> {
  const input = readBootstrapInput()
  if (cds.env.requires?.db?.kind !== 'postgres') {
    throw new Error('Admin bootstrap requires the configured PostgreSQL database')
  }
  await withStandaloneDatabase(
    async () => await cds.connect.to('db') as unknown as BootstrapDatabase,
    async db => await bootstrap(db, input)
  )
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'Admin bootstrap failed')
    process.exitCode = 1
  })

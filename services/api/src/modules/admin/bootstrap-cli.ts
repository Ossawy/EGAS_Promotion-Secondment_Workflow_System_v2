import { randomUUID } from 'node:crypto'
import { hash } from 'argon2'
import type { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../../config/env.js'
import { closePool, getPool } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'

export type BootstrapInput = {
  username: string
  displayName: string
  temporaryPassword: string
  staffIdentifier: string | null
  jobTitle: string | null
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || value.startsWith('<')) {
    throw new Error(`${name} must be supplied through machine-local environment configuration`)
  }
  return value
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim()
  return !value || value.startsWith('<') ? null : value
}

export function readBootstrapInput(): BootstrapInput {
  const input: BootstrapInput = {
    username: required('EGAS_BOOTSTRAP_ADMIN_USERNAME'),
    displayName: required('EGAS_BOOTSTRAP_ADMIN_DISPLAY_NAME'),
    temporaryPassword: required('EGAS_BOOTSTRAP_ADMIN_TEMP_PASSWORD'),
    staffIdentifier: optional('EGAS_BOOTSTRAP_ADMIN_STAFF_IDENTIFIER'),
    jobTitle: optional('EGAS_BOOTSTRAP_ADMIN_JOB_TITLE')
  }
  if (!/^[\p{L}\p{N}._@-]{3,120}$/u.test(input.username)) {
    throw new Error('Bootstrap username must be 3-120 letters, digits, or . _ @ -')
  }
  if (input.displayName.length > 300) throw new Error('Bootstrap display name exceeds 300 characters')
  if (input.temporaryPassword.length < 14 || input.temporaryPassword.length > 256) {
    throw new Error('Temporary password must be between 14 and 256 characters')
  }
  return input
}

export async function bootstrapAdmin(input: BootstrapInput, suppliedPool?: Pool): Promise<void> {
  const pool = suppliedPool ?? getPool(loadConfig())
  const passwordHash = await hash(input.temporaryPassword, { type: 2 })
  await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('egas.bootstrap.admin'))")
    const privileged = await client.query(
      `SELECT role_assignment.id
         FROM egas_useraccountrole AS role_assignment
         JOIN egas_useraccount AS account ON account.id = role_assignment.user_id
        WHERE account.isactive = TRUE
          AND role_assignment.isactive = TRUE
          AND role_assignment.role = 'ADMIN'
          AND role_assignment.canmanageadmins = TRUE
        LIMIT 1`
    )
    if (privileged.rowCount) {
      throw new Error('Bootstrap refused: an active Manage-Admins account already exists')
    }
    const duplicate = await client.query(
      'SELECT id FROM egas_useraccount WHERE username = $1 LIMIT 1',
      [input.username]
    )
    if (duplicate.rowCount) throw new Error('Bootstrap refused: username already exists')

    const userId = randomUUID()
    const now = new Date()
    await client.query(
      `INSERT INTO egas_useraccount
        (id, username, staffidentifier, displayname, jobtitle, passwordhash,
         mustchangepassword, isactive, failedlogincount, createdat, updatedat, version)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, 0, $7, $7, 1)`,
      [userId, input.username, input.staffIdentifier, input.displayName, input.jobTitle, passwordHash, now]
    )
    await client.query(
      `INSERT INTO egas_useraccountrole
        (id, user_id, role, canmanageadmins, isactive, grantedat)
       VALUES ($1, $2, 'ADMIN', TRUE, TRUE, $3)`,
      [randomUUID(), userId, now]
    )
  })
}

async function main(): Promise<void> {
  const input = readBootstrapInput()
  await bootstrapAdmin(input)
  console.info(`Bootstrap Admin created for username ${input.username}. Password change is mandatory.`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch(error => {
      console.error(error instanceof Error ? error.message : 'Admin bootstrap failed')
      process.exitCode = 1
    })
    .finally(async () => {
      await closePool()
    })
}

import { readFile } from 'node:fs/promises'
import { DataType, newDb } from 'pg-mem'
import type { Pool } from 'pg'
import type { AppConfig } from '../../src/config/env.js'

export const testConfig: AppConfig = {
  nodeEnv: 'test',
  port: 4004,
  database: { host: 'isolated', port: 5432, database: 'isolated', user: 'isolated', password: 'isolated', ssl: false },
  auth: {
    fingerprintSecret: 'synthetic-test-fingerprint-secret-32',
    sessionCookieName: 'EGAS_SESSION',
    csrfCookieName: 'EGAS_SESSION_CSRF',
    idleMinutes: 30,
    absoluteHours: 8,
    loginWindowMinutes: 10,
    loginFailureLimit: 2,
    lockoutMinutes: 15,
    requireSecureCookie: false,
    allowedOrigins: new Set()
  }
}

export async function isolatedPool(): Promise<Pool> {
  const database = newDb({ autoCreateForeignKeyIndices: true })
  database.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 1 })
  database.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 })
  const baseline = await readFile(new URL('../../src/db/baseline/000_existing_cap_schema.sql', import.meta.url), 'utf8')
  database.public.none(baseline)
  const adapter = database.adapters.createPg()
  return new adapter.Pool() as unknown as Pool
}

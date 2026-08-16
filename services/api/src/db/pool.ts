import { Pool } from 'pg'
import type { AppConfig } from '../config/env.ts'

let pool: Pool | undefined

export function createPool(config: AppConfig): Pool {
  return new Pool({
    ...config.database,
    application_name: 'egas-api',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  })
}

export function getPool(config: AppConfig): Pool {
  pool ??= createPool(config)
  return pool
}

export async function closePool(): Promise<void> {
  const active = pool
  pool = undefined
  if (active) await active.end()
}

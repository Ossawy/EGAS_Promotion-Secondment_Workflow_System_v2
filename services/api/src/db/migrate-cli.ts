import { loadConfig } from '../config/env.ts'
import { closePool, getPool } from './pool.ts'
import { migrateDatabase } from './migration-runner.ts'

try {
  const config = loadConfig()
  const results = await migrateDatabase(getPool(config))
  for (const migration of results) console.info(`Migration ${migration.version}: ${migration.result}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Database migration failed')
  process.exitCode = 1
} finally {
  await closePool()
}

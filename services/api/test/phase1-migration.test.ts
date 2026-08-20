import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { migrateDatabase } from '../src/db/migration-runner.js'
import { loadMigrations } from '../src/db/migration-runner.js'

describe('fresh v5 migration runner', () => {
  it('executes migration sequence and reports status correctly', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql, params) => {
        if (sql.includes('SELECT EXISTS')) return { rows: [{ legacy: false, current: false }] }
        if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migration')) return { rowCount: 1 }
        if (sql.includes('SELECT version, sha256 FROM schema_migration')) {
          return { rows: [] } // first run: not applied
        }
        if (sql.includes('INSERT INTO schema_migration')) return { rowCount: 1 }
        return { rows: [] }
      }),
      release: vi.fn()
    } as unknown as PoolClient

    const mockPool = {
      connect: async () => mockClient
    } as unknown as Pool

    const first = await migrateDatabase(mockPool)
    const migrations = await loadMigrations()
    expect(first).toEqual(migrations.map(m => ({ version: m.version, result: 'applied' })))
    
    // Verify tracking table was ensured before migrations were applied
    const queries = (mockClient.query as any).mock.calls.map((call: any[]) => call[0])
    const trackingTableIdx = queries.findIndex((q: string) => q.includes('CREATE TABLE IF NOT EXISTS schema_migration'))
    const firstMigrationIdx = queries.findIndex((q: string) => q.includes('SELECT version, sha256 FROM schema_migration'))
    expect(trackingTableIdx).toBeLessThan(firstMigrationIdx)
  })

  it('reports existing migrations as already-applied', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql, params) => {
        if (sql.includes('SELECT EXISTS')) return { rows: [{ legacy: false, current: true }] }
        if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migration')) return { rowCount: 1 }
        if (sql.includes('SELECT version, sha256 FROM schema_migration')) {
          // Mock that the migration was applied and checksum matches
          const migrations = await loadMigrations()
          const version = params?.[0]
          const migration = migrations.find(m => m.version === version)
          return { rows: [{ version: migration?.version, sha256: migration?.sha256 }] }
        }
        return { rows: [] }
      }),
      release: vi.fn()
    } as unknown as PoolClient

    const mockPool = {
      connect: async () => mockClient
    } as unknown as Pool

    const result = await migrateDatabase(mockPool)
    const migrations = await loadMigrations()
    expect(result).toEqual(migrations.map(m => ({ version: m.version, result: 'already-applied' })))
  })

  it('rejects checksum mismatch', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql, params) => {
        if (sql.includes('SELECT EXISTS')) return { rows: [{ legacy: false, current: true }] }
        if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migration')) return { rowCount: 1 }
        if (sql.includes('SELECT version, sha256 FROM schema_migration')) {
          return { rows: [{ version: params?.[0], sha256: 'invalid-checksum' }] }
        }
        return { rows: [] }
      }),
      release: vi.fn()
    } as unknown as PoolClient

    const mockPool = {
      connect: async () => mockClient
    } as unknown as Pool

    await expect(migrateDatabase(mockPool)).rejects.toThrow(/has changed/)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  applyTrackedPostgresMigration,
  executePostgresScript
} from '../scripts/postgres-script-executor.js'

const multiStatementScript = `
CREATE TABLE migration_probe (value text);
INSERT INTO migration_probe (value) VALUES ('a semicolon; inside a string');
DO $migration_body$
BEGIN
  PERFORM 1;
  RAISE NOTICE 'PL/pgSQL; semicolon';
END;
$migration_body$;
`

describe('PostgreSQL migration script execution', () => {
  it('passes a complete multi-statement/dollar-quoted script to one simple query', async () => {
    const exec = vi.fn().mockResolvedValue(undefined)

    await executePostgresScript({ exec }, multiStatementScript)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(multiStatementScript)
  })

  it('records the checksum only after the full script succeeds', async () => {
    const calls: string[] = []
    const exec = vi.fn(async () => { calls.push('script') })
    const recordApplied = vi.fn(async () => { calls.push('record') })

    const result = await applyTrackedPostgresMigration({
      executor: { exec },
      migration: { version: '001_probe', sha256: 'a'.repeat(64), sql: multiStatementScript },
      readApplied: async () => undefined,
      recordApplied
    })

    expect(result).toBe('applied')
    expect(calls).toEqual(['script', 'record'])
  })

  it('does not record a migration whose SQL failed', async () => {
    const failure = new Error('synthetic PostgreSQL failure')
    const recordApplied = vi.fn()

    await expect(applyTrackedPostgresMigration({
      executor: { exec: vi.fn().mockRejectedValue(failure) },
      migration: { version: '001_probe', sha256: 'a'.repeat(64), sql: multiStatementScript },
      readApplied: async () => undefined,
      recordApplied
    })).rejects.toBe(failure)

    expect(recordApplied).not.toHaveBeenCalled()
  })

  it('preserves checksum drift protection without executing the changed script', async () => {
    const exec = vi.fn()
    const recordApplied = vi.fn()

    await expect(applyTrackedPostgresMigration({
      executor: { exec },
      migration: { version: '001_probe', sha256: 'b'.repeat(64), sql: multiStatementScript },
      readApplied: async () => ({ version: '001_probe', sha256: 'a'.repeat(64) }),
      recordApplied
    })).rejects.toThrow('Applied migration 001_probe has changed')

    expect(exec).not.toHaveBeenCalled()
    expect(recordApplied).not.toHaveBeenCalled()
  })
})

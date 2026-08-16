import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config/env.js'

afterEach(() => vi.unstubAllEnvs())

function databaseEnvironment(): void {
  vi.stubEnv('EGAS_DB_HOST', 'isolated')
  vi.stubEnv('EGAS_DB_NAME', 'isolated_test')
  vi.stubEnv('EGAS_DB_USER', 'isolated')
  vi.stubEnv('EGAS_DB_PASSWORD', 'synthetic')
}

describe('fail-closed environment configuration', () => {
  it('rejects missing production fingerprint and insecure cookies', () => {
    databaseEnvironment()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('EGAS_AUTH_FINGERPRINT_SECRET', '')
    vi.stubEnv('EGAS_REQUIRE_SECURE_COOKIE', 'true')
    expect(() => loadConfig()).toThrow('EGAS_AUTH_FINGERPRINT_SECRET')
    vi.stubEnv('EGAS_AUTH_FINGERPRINT_SECRET', 'synthetic-production-fingerprint-secret')
    vi.stubEnv('EGAS_REQUIRE_SECURE_COOKIE', 'false')
    expect(() => loadConfig()).toThrow('Production requires')
  })

  it('rejects malformed trusted origins instead of enabling CORS', () => {
    databaseEnvironment()
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('EGAS_ALLOWED_ORIGINS', 'https://example.test/path')
    expect(() => loadConfig()).toThrow('invalid origin')
  })
})

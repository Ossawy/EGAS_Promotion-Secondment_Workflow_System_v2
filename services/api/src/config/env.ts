import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'

export type NodeEnvironment = 'development' | 'test' | 'production'

export type AppConfig = {
  nodeEnv: NodeEnvironment
  port: number
  database: {
    host: string
    port: number
    database: string
    user: string
    password: string
    ssl: false | { rejectUnauthorized: boolean }
  }
  auth: {
    fingerprintSecret: string
    sessionCookieName: string
    csrfCookieName: string
    idleMinutes: number
    absoluteHours: number
    loginWindowMinutes: number
    loginFailureLimit: number
    lockoutMinutes: number
    requireSecureCookie: boolean
    allowedOrigins: ReadonlySet<string>
  }
  signatures: {
    storageDirectory: string
    maxUploadBytes: number
    maxWidthPixels: number
    maxHeightPixels: number
    maxPixels: number
  }
  pdf: {
    storageDirectory: string
    maxConcurrentRenders: number
    maxQueuedRenders: number
    renderTimeoutMs: number
    maxOutputBytes: number
  }
}

let localEnvironmentLoaded = false

export function loadLocalEnvironmentFile(): void {
  if (localEnvironmentLoaded || process.env.NODE_ENV === 'test') return
  localEnvironmentLoaded = true
  try {
    loadEnvFile(new URL('../../.env', import.meta.url))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function nodeEnvironment(): NodeEnvironment {
  const value = process.env.NODE_ENV ?? 'development'
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  return value
}

export function loadConfig(): AppConfig {
  loadLocalEnvironmentFile()
  const nodeEnv = nodeEnvironment()
  const production = nodeEnv === 'production'
  const fingerprintSecret = process.env.EGAS_AUTH_FINGERPRINT_SECRET?.trim()
    ?? (nodeEnv === 'test' ? 'synthetic-test-fingerprint-secret-32' : '')
  if (fingerprintSecret.length < 32) {
    throw new Error('EGAS_AUTH_FINGERPRINT_SECRET must contain at least 32 characters')
  }
  const requireSecureCookie = boolean('EGAS_REQUIRE_SECURE_COOKIE', production)
  if (production && !requireSecureCookie) {
    throw new Error('Production requires EGAS_REQUIRE_SECURE_COOKIE=true')
  }
  const sessionCookieName = process.env.EGAS_SESSION_COOKIE_NAME?.trim() || 'EGAS_SESSION'
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionCookieName)) {
    throw new Error('EGAS_SESSION_COOKIE_NAME contains unsupported characters')
  }
  const allowedOrigins = new Set(
    (process.env.EGAS_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  )
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin)
    if (parsed.origin !== origin) throw new Error(`EGAS_ALLOWED_ORIGINS contains an invalid origin: ${origin}`)
  }
  const sslEnabled = boolean('EGAS_DB_SSL', false)
  return {
    nodeEnv,
    port: integer('EGAS_PORT', 4004, 1, 65_535),
    database: {
      host: required('EGAS_DB_HOST'),
      port: integer('EGAS_DB_PORT', 5432, 1, 65_535),
      database: required('EGAS_DB_NAME'),
      user: required('EGAS_DB_USER'),
      password: required('EGAS_DB_PASSWORD'),
      ssl: sslEnabled ? { rejectUnauthorized: boolean('EGAS_DB_SSL_REJECT_UNAUTHORIZED', true) } : false
    },
    auth: {
      fingerprintSecret,
      sessionCookieName,
      csrfCookieName: `${sessionCookieName}_CSRF`,
      idleMinutes: integer('EGAS_SESSION_IDLE_MINUTES', 30, 5, 1_440),
      absoluteHours: integer('EGAS_SESSION_ABSOLUTE_HOURS', 8, 1, 168),
      loginWindowMinutes: integer('EGAS_LOGIN_WINDOW_MINUTES', 10, 1, 60),
      loginFailureLimit: integer('EGAS_LOGIN_FAILURE_LIMIT', 5, 2, 50),
      lockoutMinutes: integer('EGAS_LOGIN_LOCKOUT_MINUTES', 15, 1, 1_440),
      requireSecureCookie,
      allowedOrigins
    },
    signatures: {
      storageDirectory: resolve(process.env.EGAS_SIGNATURE_STORAGE_DIR?.trim() || 'storage/signatures'),
      maxUploadBytes: integer('EGAS_SIGNATURE_MAX_UPLOAD_BYTES', 1_048_576, 1_024, 5_242_880),
      maxWidthPixels: integer('EGAS_SIGNATURE_MAX_WIDTH_PIXELS', 2_048, 64, 8_192),
      maxHeightPixels: integer('EGAS_SIGNATURE_MAX_HEIGHT_PIXELS', 2_048, 64, 8_192),
      maxPixels: integer('EGAS_SIGNATURE_MAX_PIXELS', 4_000_000, 4_096, 16_000_000)
    },
    pdf: {
      storageDirectory: resolve(process.env.EGAS_PDF_STORAGE_DIR?.trim() || 'storage/generated-pdfs'),
      maxConcurrentRenders: integer('EGAS_PDF_MAX_CONCURRENT_RENDERS', 2, 1, 8),
      maxQueuedRenders: integer('EGAS_PDF_MAX_QUEUED_RENDERS', 20, 0, 100),
      renderTimeoutMs: integer('EGAS_PDF_RENDER_TIMEOUT_MS', 15_000, 1_000, 60_000),
      maxOutputBytes: integer('EGAS_PDF_MAX_OUTPUT_BYTES', 20_971_520, 1_048_576, 52_428_800)
    }
  }
}

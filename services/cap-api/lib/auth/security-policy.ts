import { createHmac, timingSafeEqual } from 'node:crypto'

export const ACTIVE_ROLES = [
  'ADMIN',
  'EMPLOYEE_AFFAIRS',
  'ORGANIZATION',
  'APPROVING_AUTHORITY'
] as const

export type ActiveRole = typeof ACTIVE_ROLES[number]

export type SecurityPolicy = {
  sessionCookieName: string
  csrfCookieName: string
  idleMinutes: number
  absoluteHours: number
  loginWindowMinutes: number
  loginFailureLimit: number
  lockoutMinutes: number
  requireSecureCookie: boolean
  fingerprintSecret: string
  allowedOrigins: ReadonlySet<string>
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function loadSecurityPolicy(): SecurityPolicy {
  const production = process.env.NODE_ENV === 'production'
  const fingerprintSecret = process.env.EGAS_AUTH_FINGERPRINT_SECRET?.trim()
    ?? (process.env.NODE_ENV === 'test' ? 'synthetic-test-fingerprint-secret-32' : '')
  if (fingerprintSecret.length < 32) {
    throw new Error('EGAS_AUTH_FINGERPRINT_SECRET must contain at least 32 characters')
  }

  const requireSecureCookie = booleanValue('EGAS_REQUIRE_SECURE_COOKIE', production)
  if (production && !requireSecureCookie) {
    throw new Error('Production requires EGAS_REQUIRE_SECURE_COOKIE=true')
  }

  const sessionCookieName = process.env.EGAS_SESSION_COOKIE_NAME?.trim() || 'EGAS_SESSION'
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionCookieName)) {
    throw new Error('EGAS_SESSION_COOKIE_NAME contains unsupported characters')
  }

  const allowedOrigins = new Set(
    (process.env.EGAS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )

  return {
    sessionCookieName,
    csrfCookieName: `${sessionCookieName}_CSRF`,
    idleMinutes: boundedInteger('EGAS_SESSION_IDLE_MINUTES', 30, 5, 1_440),
    absoluteHours: boundedInteger('EGAS_SESSION_ABSOLUTE_HOURS', 8, 1, 168),
    loginWindowMinutes: boundedInteger('EGAS_LOGIN_WINDOW_MINUTES', 10, 1, 60),
    loginFailureLimit: boundedInteger('EGAS_LOGIN_FAILURE_LIMIT', 5, 2, 50),
    lockoutMinutes: boundedInteger('EGAS_LOGIN_LOCKOUT_MINUTES', 15, 1, 1_440),
    requireSecureCookie,
    fingerprintSecret,
    allowedOrigins
  }
}

export function fingerprintIdentifier(value: string, policy: SecurityPolicy): string {
  return createHmac('sha256', policy.fingerprintSecret)
    .update(value.trim().toLocaleLowerCase('en-US'), 'utf8')
    .digest('hex')
}

export function isActiveRole(value: unknown): value is ActiveRole {
  return typeof value === 'string' && (ACTIVE_ROLES as readonly string[]).includes(value)
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function validatePassword(password: unknown, field = 'newPassword'): string {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) {
    throw new SafeRequestError(400, `${field} must be between 14 and 256 characters`)
  }
  return password
}

export class SafeRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    status: number,
    message: string,
    code = 'EGAS_REQUEST_REJECTED'
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

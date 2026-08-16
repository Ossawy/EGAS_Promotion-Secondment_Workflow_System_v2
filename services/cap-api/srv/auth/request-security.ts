import type { Service } from '@sap/cds'
import type { Request as ExpressRequest, Response } from 'express'
import { LocalAuthenticationProvider } from '../../lib/auth/local-authentication-provider.ts'
import type { RequestEvidence } from '../../lib/auth/auth-operations.ts'
import {
  type ActiveRole,
  type SecurityPolicy,
  SafeRequestError,
  secureEqual
} from '../../lib/auth/security-policy.ts'

type CdsHttpRequest = {
  http?: { req?: ExpressRequest, res?: Response }
  headers?: Record<string, string | string[] | undefined>
  user?: {
    id?: string
    attr?: Record<string, unknown>
  }
}

export type RequestPrincipal = {
  userId: string
  sessionId: string
  activeRole: ActiveRole | null
  mustChangePassword: boolean
  canManageAdmins: boolean
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

function expressRequest(request: CdsHttpRequest): ExpressRequest | undefined {
  return request.http?.req
}

export function requestEvidence(request: CdsHttpRequest): RequestEvidence {
  const http = expressRequest(request)
  const socketIp = http?.socket?.remoteAddress ?? null
  const ipAddress = socketIp?.startsWith('::ffff:') ? socketIp.slice(7) : socketIp
  const requestId = request.headers?.['x-correlation-id']
  return {
    ipAddress: ipAddress?.slice(0, 45) ?? null,
    userAgent: http?.headers['user-agent']?.slice(0, 1_000) ?? null,
    correlationId: typeof requestId === 'string' ? requestId.slice(0, 120) : null
  }
}

export function requireTrustedOrigin(request: CdsHttpRequest, policy: SecurityPolicy): void {
  const http = expressRequest(request)
  const origin = http?.headers.origin
  if (!origin) return
  const host = http.headers.host
  let sameOrigin = false
  try {
    sameOrigin = Boolean(host && new URL(origin).host === host)
  } catch {
    throw new SafeRequestError(403, 'Request origin is not allowed', 'ORIGIN_REJECTED')
  }
  if (!sameOrigin && !policy.allowedOrigins.has(origin)) {
    throw new SafeRequestError(403, 'Request origin is not allowed', 'ORIGIN_REJECTED')
  }
}

export function principalFromRequest(request: CdsHttpRequest): RequestPrincipal {
  const attr = request.user?.attr ?? {}
  const userId = request.user?.id
  const sessionId = attr.sessionId
  if (!userId || userId === 'anonymous' || typeof sessionId !== 'string') {
    throw new SafeRequestError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED')
  }
  return {
    userId,
    sessionId,
    activeRole: typeof attr.activeRole === 'string' ? attr.activeRole as ActiveRole : null,
    mustChangePassword: attr.mustChangePassword === true || attr.mustChangePassword === 'true',
    canManageAdmins: attr.canManageAdmins === true || attr.canManageAdmins === 'true'
  }
}

export function requireAdmin(request: CdsHttpRequest): RequestPrincipal {
  const principal = principalFromRequest(request)
  if (principal.mustChangePassword || principal.activeRole !== 'ADMIN') {
    throw new SafeRequestError(403, 'Active ADMIN role required', 'ADMIN_REQUIRED')
  }
  return principal
}

export async function requireCsrf(
  request: CdsHttpRequest,
  db: Service,
  policy: SecurityPolicy,
  sessionId: string
): Promise<void> {
  requireTrustedOrigin(request, policy)
  const http = expressRequest(request)
  const headerValue = http?.headers['x-csrf-token']
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const cookieToken = readCookie(http?.headers.cookie, policy.csrfCookieName)
  if (!token || !cookieToken || !secureEqual(token, cookieToken)) {
    throw new SafeRequestError(403, 'Invalid CSRF token', 'CSRF_REJECTED')
  }
  const session = await db.run(
    SELECT.one.from('egas.AuthSession').columns('csrfSecretHash')
      .where({ ID: sessionId, revokedAt: null })
  ) as { csrfSecretHash: string | null } | undefined
  const actualHash = new LocalAuthenticationProvider(db).hashSessionToken(token)
  if (!session?.csrfSecretHash || !secureEqual(actualHash, session.csrfSecretHash)) {
    throw new SafeRequestError(403, 'Invalid CSRF token', 'CSRF_REJECTED')
  }
}

export function issueSessionCookies(
  request: CdsHttpRequest,
  policy: SecurityPolicy,
  sessionToken: string,
  csrfToken: string,
  absoluteExpiresAt: string
): void {
  const response = request.http?.res
  if (!response) throw new Error('HTTP response is unavailable for session cookies')
  const expires = new Date(absoluteExpiresAt)
  const common = {
    secure: policy.requireSecureCookie,
    sameSite: 'strict' as const,
    path: '/',
    expires
  }
  response.cookie(policy.sessionCookieName, sessionToken, { ...common, httpOnly: true })
  response.cookie(policy.csrfCookieName, csrfToken, { ...common, httpOnly: false })
  response.setHeader('Cache-Control', 'no-store')
}

export function clearSessionCookies(request: CdsHttpRequest, policy: SecurityPolicy): void {
  const response = request.http?.res
  if (!response) return
  const options = {
    secure: policy.requireSecureCookie,
    sameSite: 'strict' as const,
    path: '/'
  }
  response.clearCookie(policy.sessionCookieName, { ...options, httpOnly: true })
  response.clearCookie(policy.csrfCookieName, { ...options, httpOnly: false })
  response.setHeader('Cache-Control', 'no-store')
}

export function rejectSafely(request: { reject: (status: number, message: string) => never }, error: unknown): never {
  if (error instanceof SafeRequestError) return request.reject(error.status, error.message)
  throw error
}

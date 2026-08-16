import { isActiveRole, type ActiveRole, SafeRequestError } from '../auth/security-policy.ts'

export const AUTHORITY_KINDS = [
  'DEPUTY', 'ASSISTANT', 'ACTING_DEPUTY', 'ACTING_ASSISTANT', 'OTHER'
] as const
export type AuthorityKind = typeof AUTHORITY_KINDS[number]

export function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new SafeRequestError(400, `${field} must be a UUID`)
  }
  return value
}

export function requiredText(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new SafeRequestError(400, `${field} is required`)
  const text = value.trim()
  if (text.length < minimum || text.length > maximum) {
    throw new SafeRequestError(400, `${field} must be ${minimum}-${maximum} characters`)
  }
  return text
}

export function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, field, maximum)
}

export function requiredRole(value: unknown): ActiveRole {
  if (!isActiveRole(value)) throw new SafeRequestError(400, 'Unsupported role')
  return value
}

export function requiredAuthorityKind(value: unknown): AuthorityKind {
  if (typeof value !== 'string' || !(AUTHORITY_KINDS as readonly string[]).includes(value)) {
    throw new SafeRequestError(400, 'Unsupported authority kind')
  }
  return value as AuthorityKind
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new SafeRequestError(400, `${field} must be boolean`)
  return value
}

export function optionalDate(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SafeRequestError(400, `${field} must be YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SafeRequestError(400, `${field} is invalid`)
  }
  return value
}

export function optionalTimestamp(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new SafeRequestError(400, `${field} must be an ISO timestamp`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new SafeRequestError(400, `${field} is invalid`)
  return parsed.toISOString()
}

export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SafeRequestError(400, 'expectedVersion must be a positive integer')
  }
  return value as number
}

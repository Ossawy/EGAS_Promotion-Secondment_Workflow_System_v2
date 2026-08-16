import { AppError } from './errors.ts'

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, `${field} must be a UUID`)
  }
  return value
}

export function text(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new AppError(400, `${field} is required`)
  const result = value.trim()
  if (result.length < minimum || result.length > maximum) {
    throw new AppError(400, `${field} must be ${minimum}-${maximum} characters`)
  }
  return result
}

export function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, field, maximum)
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new AppError(400, `${field} must be boolean`)
  return value
}

export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AppError(400, 'expectedVersion must be a positive integer')
  }
  return value as number
}

export function date(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(400, `${field} is invalid`)
  }
  return value
}

export function timestamp(value: unknown, field: string, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new AppError(400, `${field} must be an ISO timestamp`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new AppError(400, `${field} is invalid`)
  return parsed.toISOString()
}

export function password(value: unknown, field = 'newPassword'): string {
  if (typeof value !== 'string' || value.length < 14 || value.length > 256) {
    throw new AppError(400, `${field} must be between 14 and 256 characters`)
  }
  return value
}

export function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'JSON object required')
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !allowed.includes(key))
  if (unknown.length) throw new AppError(400, `Unknown field: ${unknown[0]}`)
  return record
}

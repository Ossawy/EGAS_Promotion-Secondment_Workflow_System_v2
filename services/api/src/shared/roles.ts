import { AppError } from './errors.ts'

export const ROLES = ['ADMIN', 'EMPLOYEE_AFFAIRS', 'ORGANIZATION', 'APPROVING_AUTHORITY'] as const
export type Role = typeof ROLES[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function requireRole(value: unknown): Role {
  if (!isRole(value)) throw new AppError(400, 'Unsupported role')
  return value
}

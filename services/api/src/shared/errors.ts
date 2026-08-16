export class AppError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'EGAS_REQUEST_REJECTED') {
    super(message)
    this.status = status
    this.code = code
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

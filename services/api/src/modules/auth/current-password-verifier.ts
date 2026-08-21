import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'
import type { AuthenticationProvider } from './authentication-provider.ts'

type PasswordRow = {
  passwordHash: string
}

export interface CurrentPasswordVerifier {
  verify(
    db: Queryable,
    userId: string,
    password: string
  ): Promise<boolean>
}

export class DatabaseCurrentPasswordVerifier implements CurrentPasswordVerifier {
  constructor(
    private readonly authenticationProvider: AuthenticationProvider
  ) {}

  async verify(
    db: Queryable,
    userId: string,
    password: string
  ): Promise<boolean> {
    const result = await db.query<PasswordRow>(
      `SELECT password_hash AS "passwordHash"
         FROM user_account
        WHERE id = $1
          AND is_active = TRUE`,
      [userId]
    )

    const account = result.rows[0]
    if (!account) return false

    return await this.authenticationProvider.verifyPassword(
      account.passwordHash,
      password
    )
  }
}

export function signaturePassword(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new AppError(
      400,
      'Password confirmation is required before signing',
      'SIGNATURE_PASSWORD_REQUIRED'
    )
  }

  if (typeof value !== 'string' || value.length < 8 || value.length > 256) {
    throw new AppError(
      400,
      'Signature password must be between 8 and 256 characters',
      'SIGNATURE_PASSWORD_INVALID_FORMAT'
    )
  }

  return value
}
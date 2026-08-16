import type { AuthContext } from './types.ts'

export interface AuthenticationProvider {
  hashPassword(password: string): Promise<string>
  verifyPassword(passwordHash: string, password: string): Promise<boolean>
  generateSessionToken(): string
  hashSessionToken(token: string): string
  resolveSessionToken(token: string): Promise<AuthContext | null>
}

export type ActiveRole =
  | 'ADMIN'
  | 'EMPLOYEE_AFFAIRS'
  | 'ORGANIZATION'
  | 'APPROVING_AUTHORITY'

export interface AuthenticatedPrincipal {
  userId: string
  sessionId: string
  activeRole: ActiveRole | null
  mustChangePassword: boolean
  canManageAdmins: boolean
}

export interface AuthenticationProvider {
  hashPassword(password: string): Promise<string>
  verifyPassword(passwordHash: string, password: string): Promise<boolean>
  generateSessionToken(): string
  hashSessionToken(token: string): string
  resolveSessionToken(token: string): Promise<AuthenticatedPrincipal | null>
}

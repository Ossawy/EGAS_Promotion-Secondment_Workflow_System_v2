import cds, { type Request } from '@sap/cds'
import { AuthOperations } from '../lib/auth/auth-operations.ts'
import { loadSecurityPolicy, SafeRequestError } from '../lib/auth/security-policy.ts'
import {
  clearSessionCookies,
  issueSessionCookies,
  principalFromRequest,
  rejectSafely,
  requestEvidence,
  requireCsrf,
  requireTrustedOrigin
} from './auth/request-security.ts'

type AuthRequest = Request & { data: Record<string, unknown> }

export default class AuthService extends cds.ApplicationService {
  override async init(): Promise<void> {
    const db = await cds.connect.to('db')
    const policy = loadSecurityPolicy()
    const operations = new AuthOperations(db, policy)

    this.on('login', async request => {
      const req = request as AuthRequest
      try {
        requireTrustedOrigin(req, policy)
        const issued = await operations.login(
          req.data.username, req.data.password, requestEvidence(req)
        )
        issueSessionCookies(req, policy, issued.sessionToken, issued.csrfToken, issued.absoluteExpiresAt)
        return issued.context
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    this.on('me', async request => {
      const req = request as AuthRequest
      try {
        const principal = principalFromRequest(req)
        return await operations.getContext(principal.userId, principal.sessionId)
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    this.on('logout', async request => {
      const req = request as AuthRequest
      try {
        requireTrustedOrigin(req, policy)
        let principal
        try {
          principal = principalFromRequest(req)
        } catch (error) {
          if (!(error instanceof SafeRequestError) || error.status !== 401) throw error
          clearSessionCookies(req, policy)
          return true
        }
        await requireCsrf(req, db, policy, principal.sessionId)
        await operations.logout(principal.userId, principal.sessionId, requestEvidence(req))
        clearSessionCookies(req, policy)
        return true
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    this.on('changePassword', async request => {
      const req = request as AuthRequest
      try {
        const principal = principalFromRequest(req)
        await requireCsrf(req, db, policy, principal.sessionId)
        const issued = await operations.changePassword(
          principal.userId, principal.sessionId,
          req.data.currentPassword, req.data.newPassword, requestEvidence(req)
        )
        issueSessionCookies(req, policy, issued.sessionToken, issued.csrfToken, issued.absoluteExpiresAt)
        return issued.context
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    this.on('selectActiveRole', async request => {
      const req = request as AuthRequest
      try {
        const principal = principalFromRequest(req)
        await requireCsrf(req, db, policy, principal.sessionId)
        const issued = await operations.selectActiveRole(
          principal.userId, principal.sessionId, req.data.role, requestEvidence(req)
        )
        issueSessionCookies(req, policy, issued.sessionToken, issued.csrfToken, issued.absoluteExpiresAt)
        return issued.context
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    await super.init()
  }
}

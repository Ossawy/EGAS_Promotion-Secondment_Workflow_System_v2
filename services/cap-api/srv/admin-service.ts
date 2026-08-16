import cds, { type Request } from '@sap/cds'
import { AdminAccountOperations, type AdminActor } from '../lib/admin/admin-account-operations.ts'
import { AuthorityOperations } from '../lib/admin/authority-operations.ts'
import { loadSecurityPolicy } from '../lib/auth/security-policy.ts'
import {
  rejectSafely, requestEvidence, requireAdmin, requireCsrf
} from './auth/request-security.ts'

type AdminRequest = Request & { data: Record<string, unknown> }

export default class AdminService extends cds.ApplicationService {
  override async init(): Promise<void> {
    const db = await cds.connect.to('db')
    const policy = loadSecurityPolicy()
    const accounts = new AdminAccountOperations(db)
    const authority = new AuthorityOperations(db)

    const mutation = (
      name: string,
      operation: (actor: AdminActor, data: Record<string, unknown>, req: AdminRequest) => Promise<unknown>
    ): void => {
      this.on(name, async request => {
        const req = request as AdminRequest
        try {
          const principal = requireAdmin(req)
          const admin = {
            userId: principal.userId,
            canManageAdmins: principal.canManageAdmins
          }
          await requireCsrf(req, db, policy, principal.sessionId)
          return await operation(admin, req.data, req)
        } catch (error) {
          return rejectSafely(req, error)
        }
      })
    }

    this.on('listUsers', async request => {
      const req = request as AdminRequest
      try {
        requireAdmin(req)
        return await accounts.listUsers(req.data.search, req.data.skip, req.data.top)
      } catch (error) {
        return rejectSafely(req, error)
      }
    })
    this.on('getUser', async request => {
      const req = request as AdminRequest
      try {
        requireAdmin(req)
        return await accounts.getUser(req.data.userId)
      } catch (error) {
        return rejectSafely(req, error)
      }
    })
    this.on('listAuthorityAssignments', async request => {
      const req = request as AdminRequest
      try {
        requireAdmin(req)
        return await authority.listAssignments(req.data.routingUnitId, req.data.activeOnly)
      } catch (error) {
        return rejectSafely(req, error)
      }
    })
    this.on('listDelegations', async request => {
      const req = request as AdminRequest
      try {
        requireAdmin(req)
        return await authority.listDelegations(req.data.assignmentId, req.data.activeOnly)
      } catch (error) {
        return rejectSafely(req, error)
      }
    })

    mutation('createUser', async (admin, data, req) =>
      await accounts.createUser(admin, data, requestEvidence(req)))
    mutation('updateUser', async (admin, data, req) =>
      await accounts.updateUser(admin, data, requestEvidence(req)))
    mutation('assignRole', async (admin, data, req) =>
      await accounts.assignRole(admin, data, requestEvidence(req)))
    mutation('revokeRole', async (admin, data, req) =>
      await accounts.revokeRole(admin, data, requestEvidence(req)))
    mutation('disableUser', async (admin, data, req) =>
      await accounts.setAccountActive(admin, data, false, requestEvidence(req)))
    mutation('enableUser', async (admin, data, req) =>
      await accounts.setAccountActive(admin, data, true, requestEvidence(req)))
    mutation('unlockUser', async (admin, data, req) =>
      await accounts.unlockUser(admin, data, requestEvidence(req)))
    mutation('resetPassword', async (admin, data, req) =>
      await accounts.resetPassword(admin, data, requestEvidence(req)))

    mutation('createAuthorityAssignment', async (admin, data, req) =>
      await authority.createAssignment(admin, data, requestEvidence(req)))
    mutation('updateAuthorityAssignment', async (admin, data, req) =>
      await authority.updateAssignment(admin, data, requestEvidence(req)))
    mutation('deactivateAuthorityAssignment', async (admin, data, req) =>
      await authority.deactivateAssignment(admin, data, requestEvidence(req)))
    mutation('createDelegation', async (admin, data, req) =>
      await authority.createDelegation(admin, data, requestEvidence(req)))
    mutation('updateDelegation', async (admin, data, req) =>
      await authority.updateDelegation(admin, data, requestEvidence(req)))
    mutation('deactivateDelegation', async (admin, data, req) =>
      await authority.deactivateDelegation(admin, data, requestEvidence(req)))

    await super.init()
  }
}

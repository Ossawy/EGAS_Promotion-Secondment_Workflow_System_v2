import { randomUUID } from 'node:crypto'
import type { Service } from '@sap/cds'
import { recordSecurityEvent } from '../audit/security-events.ts'
import type { RequestEvidence } from '../auth/auth-operations.ts'
import { SafeRequestError } from '../auth/security-policy.ts'
import type { AdminActor } from './admin-account-operations.ts'
import {
  expectedVersion,
  optionalDate,
  optionalText,
  optionalTimestamp,
  requiredAuthorityKind,
  requiredBoolean,
  requiredText,
  requiredUuid
} from './validation.ts'

type AssignmentRow = {
  ID: string
  routingUnit_ID: string
  userAccount_ID: string
  authorityKind: string
  authorityJobTitle: string
  isPrimary: boolean
  validFrom: string
  validTo: string | null
  isActive: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  version: number
}

type DelegationRow = {
  ID: string
  authorityAssignment_ID: string
  delegatedUser_ID: string
  validFrom: string
  validTo: string | null
  isActive: boolean
  reason: string | null
  createdAt: string
  version: number
}

function now(): string {
  return new Date().toISOString()
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function ensureOrdered(from: string, to: string | null, field = 'validTo'): void {
  if (to && new Date(to).getTime() < new Date(from).getTime()) {
    throw new SafeRequestError(400, `${field} must not precede validFrom`)
  }
}

export class AuthorityOperations {
  private readonly db: Service

  constructor(db: Service) {
    this.db = db
  }

  private async assignment(db: Service, id: string): Promise<AssignmentRow> {
    const row = await db.run(
      SELECT.one.from('egas.ApprovingAuthorityAssignment')
        .columns(
          'ID', 'routingUnit_ID', 'userAccount_ID', 'authorityKind', 'authorityJobTitle',
          'isPrimary', 'validFrom', 'validTo', 'isActive', 'notes', 'createdAt', 'updatedAt', 'version'
        )
        .where({ ID: id })
    ) as AssignmentRow | undefined
    if (!row) throw new SafeRequestError(404, 'Authority assignment not found')
    return row
  }

  private async delegation(db: Service, id: string): Promise<DelegationRow> {
    const row = await db.run(
      SELECT.one.from('egas.AuthorityDelegation')
        .columns(
          'ID', 'authorityAssignment_ID', 'delegatedUser_ID', 'validFrom', 'validTo',
          'isActive', 'reason', 'createdAt', 'version'
        )
        .where({ ID: id })
    ) as DelegationRow | undefined
    if (!row) throw new SafeRequestError(404, 'Authority delegation not found')
    return row
  }

  private async requireEligibleAuthority(db: Service, userId: string): Promise<void> {
    const account = await db.run(
      SELECT.one.from('egas.UserAccount').columns('ID').where({ ID: userId, isActive: true })
    ) as { ID: string } | undefined
    const role = await db.run(
      SELECT.one.from('egas.UserAccountRole').columns('ID')
        .where({ user_ID: userId, role: 'APPROVING_AUTHORITY', isActive: true })
    ) as { ID: string } | undefined
    if (!account || !role) {
      throw new SafeRequestError(400, 'Account must be active with an active APPROVING_AUTHORITY role')
    }
  }

  private async requireActiveRoutingUnit(db: Service, routingUnitId: string): Promise<void> {
    const unit = await db.run(
      SELECT.one.from('egas.RoutingUnit').columns('ID').where({ ID: routingUnitId, isActive: true })
    ) as { ID: string } | undefined
    if (!unit) throw new SafeRequestError(400, 'Routing unit is missing or inactive')
  }

  private async ensurePrimaryAvailable(
    db: Service,
    routingUnitId: string,
    isPrimary: boolean,
    exceptId?: string
  ): Promise<void> {
    if (!isPrimary) return
    const existing = await db.run(
      SELECT.one.from('egas.ApprovingAuthorityAssignment').columns('ID')
        .where({ routingUnit_ID: routingUnitId, isPrimary: true, isActive: true })
    ) as { ID: string } | undefined
    if (existing && existing.ID !== exceptId) {
      throw new SafeRequestError(409, 'Routing unit already has an active primary authority')
    }
  }

  private async revokeSessions(db: Service, userIds: string[], reason: string): Promise<void> {
    for (const userId of new Set(userIds)) {
      await db.run(UPDATE('egas.AuthSession').set({
        revokedAt: now(), revokedReason: reason
      }).where({ user_ID: userId, revokedAt: null }))
    }
  }

  async listAssignments(routingUnitValue: unknown, activeOnlyValue: unknown): Promise<AssignmentRow[]> {
    const routingUnitId = routingUnitValue
      ? requiredUuid(routingUnitValue, 'routingUnitId') : null
    const activeOnly = activeOnlyValue === undefined ? true : requiredBoolean(activeOnlyValue, 'activeOnly')
    const where: Record<string, unknown> = {}
    if (routingUnitId) where.routingUnit_ID = routingUnitId
    if (activeOnly) where.isActive = true
    return await this.db.run(
      SELECT.from('egas.ApprovingAuthorityAssignment')
        .columns(
          'ID', 'routingUnit_ID', 'userAccount_ID', 'authorityKind', 'authorityJobTitle',
          'isPrimary', 'validFrom', 'validTo', 'isActive', 'notes', 'createdAt', 'updatedAt', 'version'
        )
        .where(where)
        .orderBy('routingUnit_ID', 'createdAt')
        .limit(100)
    ) as AssignmentRow[]
  }

  async createAssignment(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<AssignmentRow> {
    const routingUnitId = requiredUuid(input.routingUnitId, 'routingUnitId')
    const userAccountId = requiredUuid(input.userAccountId, 'userAccountId')
    if (userAccountId === actor.userId) {
      throw new SafeRequestError(403, 'Admins cannot configure their own authority assignment')
    }
    const authorityKind = requiredAuthorityKind(input.authorityKind)
    const authorityJobTitle = requiredText(input.authorityJobTitle, 'authorityJobTitle', 500)
    const isPrimary = input.isPrimary === undefined ? true : requiredBoolean(input.isPrimary, 'isPrimary')
    const validFrom = optionalDate(input.validFrom, 'validFrom', today()) as string
    const validTo = optionalDate(input.validTo, 'validTo')
    const notes = optionalText(input.notes, 'notes', 2_000)
    ensureOrdered(validFrom, validTo)

    return await this.db.tx(async tx => {
      await this.requireActiveRoutingUnit(tx, routingUnitId)
      await this.requireEligibleAuthority(tx, userAccountId)
      await this.ensurePrimaryAvailable(tx, routingUnitId, isPrimary)
      const id = randomUUID()
      const createdAt = now()
      await tx.run(INSERT.into('egas.ApprovingAuthorityAssignment').entries({
        ID: id,
        routingUnit_ID: routingUnitId,
        userAccount_ID: userAccountId,
        authorityKind,
        authorityJobTitle,
        isPrimary,
        validFrom,
        validTo,
        isActive: true,
        configuredBy_ID: actor.userId,
        notes,
        createdAt,
        updatedAt: createdAt,
        version: 1
      }))
      await this.revokeSessions(tx, [userAccountId], 'AUTHORITY_ASSIGNMENT_CHANGED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_ASSIGNMENT_CREATED',
        routingUnitId,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { assignmentId: id, authorityUserId: userAccountId, authorityKind, isPrimary }
      })
      return await this.assignment(tx, id)
    })
  }

  async updateAssignment(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<AssignmentRow> {
    const id = requiredUuid(input.assignmentId, 'assignmentId')
    const version = expectedVersion(input.expectedVersion)
    const authorityKind = requiredAuthorityKind(input.authorityKind)
    const authorityJobTitle = requiredText(input.authorityJobTitle, 'authorityJobTitle', 500)
    const isPrimary = requiredBoolean(input.isPrimary, 'isPrimary')
    const validFrom = optionalDate(input.validFrom, 'validFrom')
    if (!validFrom) throw new SafeRequestError(400, 'validFrom is required')
    const validTo = optionalDate(input.validTo, 'validTo')
    const notes = optionalText(input.notes, 'notes', 2_000)
    ensureOrdered(validFrom, validTo)
    return await this.db.tx(async tx => {
      const current = await this.assignment(tx, id)
      if (current.userAccount_ID === actor.userId) {
        throw new SafeRequestError(403, 'Admins cannot configure their own authority assignment')
      }
      if (current.version !== version) throw new SafeRequestError(409, 'Authority assignment changed; refresh')
      await this.requireEligibleAuthority(tx, current.userAccount_ID)
      await this.ensurePrimaryAvailable(tx, current.routingUnit_ID, isPrimary, id)
      const affected = await tx.run(UPDATE('egas.ApprovingAuthorityAssignment').set({
        authorityKind,
        authorityJobTitle,
        isPrimary,
        validFrom,
        validTo,
        notes,
        updatedAt: now(),
        version: version + 1
      }).where({ ID: id, version }))
      if (affected !== 1) throw new SafeRequestError(409, 'Authority assignment changed; refresh')
      await this.revokeSessions(tx, [current.userAccount_ID], 'AUTHORITY_ASSIGNMENT_CHANGED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_ASSIGNMENT_UPDATED',
        routingUnitId: current.routingUnit_ID,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { assignmentId: id, authorityKind, isPrimary }
      })
      return await this.assignment(tx, id)
    })
  }

  async deactivateAssignment(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<AssignmentRow> {
    const id = requiredUuid(input.assignmentId, 'assignmentId')
    const version = expectedVersion(input.expectedVersion)
    return await this.db.tx(async tx => {
      const current = await this.assignment(tx, id)
      if (current.userAccount_ID === actor.userId) {
        throw new SafeRequestError(403, 'Admins cannot configure their own authority assignment')
      }
      if (current.version !== version) throw new SafeRequestError(409, 'Authority assignment changed; refresh')
      const affected = await tx.run(UPDATE('egas.ApprovingAuthorityAssignment').set({
        isActive: false, updatedAt: now(), version: version + 1
      }).where({ ID: id, version }))
      if (affected !== 1) throw new SafeRequestError(409, 'Authority assignment changed; refresh')
      const delegations = await tx.run(
        SELECT.from('egas.AuthorityDelegation').columns('ID', 'version')
          .where({ authorityAssignment_ID: id, isActive: true })
      ) as Array<{ ID: string, version: number }>
      for (const delegation of delegations) {
        const delegationAffected = await tx.run(UPDATE('egas.AuthorityDelegation').set({
          isActive: false, version: delegation.version + 1
        }).where({ ID: delegation.ID, version: delegation.version }))
        if (delegationAffected !== 1) throw new SafeRequestError(409, 'Delegation changed; refresh')
      }
      await this.revokeSessions(tx, [current.userAccount_ID], 'AUTHORITY_ASSIGNMENT_DEACTIVATED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_ASSIGNMENT_DEACTIVATED',
        routingUnitId: current.routingUnit_ID,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { assignmentId: id }
      })
      return await this.assignment(tx, id)
    })
  }

  async listDelegations(assignmentValue: unknown, activeOnlyValue: unknown): Promise<DelegationRow[]> {
    const assignmentId = assignmentValue
      ? requiredUuid(assignmentValue, 'assignmentId') : null
    const activeOnly = activeOnlyValue === undefined ? true : requiredBoolean(activeOnlyValue, 'activeOnly')
    const where: Record<string, unknown> = {}
    if (assignmentId) where.authorityAssignment_ID = assignmentId
    if (activeOnly) where.isActive = true
    return await this.db.run(
      SELECT.from('egas.AuthorityDelegation')
        .columns(
          'ID', 'authorityAssignment_ID', 'delegatedUser_ID', 'validFrom', 'validTo',
          'isActive', 'reason', 'createdAt', 'version'
        )
        .where(where)
        .orderBy('createdAt')
        .limit(100)
    ) as DelegationRow[]
  }

  async createDelegation(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<DelegationRow> {
    const assignmentId = requiredUuid(input.assignmentId, 'assignmentId')
    const delegatedUserId = requiredUuid(input.delegatedUserId, 'delegatedUserId')
    if (delegatedUserId === actor.userId) {
      throw new SafeRequestError(403, 'Admins cannot delegate authority to themselves')
    }
    const validFrom = optionalTimestamp(input.validFrom, 'validFrom', now()) as string
    const validTo = optionalTimestamp(input.validTo, 'validTo')
    const reason = optionalText(input.reason, 'reason', 2_000)
    ensureOrdered(validFrom, validTo)
    return await this.db.tx(async tx => {
      const assignment = await this.assignment(tx, assignmentId)
      if (!assignment.isActive) throw new SafeRequestError(400, 'Authority assignment is inactive')
      if (assignment.userAccount_ID === delegatedUserId) {
        throw new SafeRequestError(400, 'Self-delegation is prohibited')
      }
      await this.requireEligibleAuthority(tx, assignment.userAccount_ID)
      await this.requireEligibleAuthority(tx, delegatedUserId)
      const id = randomUUID()
      await tx.run(INSERT.into('egas.AuthorityDelegation').entries({
        ID: id,
        authorityAssignment_ID: assignmentId,
        delegatedUser_ID: delegatedUserId,
        createdBy_ID: actor.userId,
        validFrom,
        validTo,
        isActive: true,
        reason,
        createdAt: now(),
        version: 1
      }))
      await this.revokeSessions(
        tx, [assignment.userAccount_ID, delegatedUserId], 'AUTHORITY_DELEGATION_CHANGED'
      )
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_DELEGATION_CREATED',
        routingUnitId: assignment.routingUnit_ID,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { delegationId: id, assignmentId, delegatedUserId }
      })
      return await this.delegation(tx, id)
    })
  }

  async updateDelegation(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<DelegationRow> {
    const id = requiredUuid(input.delegationId, 'delegationId')
    const version = expectedVersion(input.expectedVersion)
    const validFrom = optionalTimestamp(input.validFrom, 'validFrom')
    if (!validFrom) throw new SafeRequestError(400, 'validFrom is required')
    const validTo = optionalTimestamp(input.validTo, 'validTo')
    const reason = optionalText(input.reason, 'reason', 2_000)
    ensureOrdered(validFrom, validTo)
    return await this.db.tx(async tx => {
      const current = await this.delegation(tx, id)
      if (current.version !== version) throw new SafeRequestError(409, 'Delegation changed; refresh')
      const assignment = await this.assignment(tx, current.authorityAssignment_ID)
      if (current.delegatedUser_ID === actor.userId) {
        throw new SafeRequestError(403, 'Admins cannot modify delegation to themselves')
      }
      await this.requireEligibleAuthority(tx, current.delegatedUser_ID)
      const affected = await tx.run(UPDATE('egas.AuthorityDelegation').set({
        validFrom, validTo, reason, version: version + 1
      }).where({ ID: id, version }))
      if (affected !== 1) throw new SafeRequestError(409, 'Delegation changed; refresh')
      await this.revokeSessions(
        tx, [assignment.userAccount_ID, current.delegatedUser_ID], 'AUTHORITY_DELEGATION_CHANGED'
      )
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_DELEGATION_UPDATED',
        routingUnitId: assignment.routingUnit_ID,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { delegationId: id, assignmentId: assignment.ID }
      })
      return await this.delegation(tx, id)
    })
  }

  async deactivateDelegation(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<DelegationRow> {
    const id = requiredUuid(input.delegationId, 'delegationId')
    const version = expectedVersion(input.expectedVersion)
    return await this.db.tx(async tx => {
      const current = await this.delegation(tx, id)
      if (current.version !== version) throw new SafeRequestError(409, 'Delegation changed; refresh')
      const assignment = await this.assignment(tx, current.authorityAssignment_ID)
      if (current.delegatedUser_ID === actor.userId) {
        throw new SafeRequestError(403, 'Admins cannot modify delegation to themselves')
      }
      const affected = await tx.run(UPDATE('egas.AuthorityDelegation').set({
        isActive: false, version: version + 1
      }).where({ ID: id, version }))
      if (affected !== 1) throw new SafeRequestError(409, 'Delegation changed; refresh')
      await this.revokeSessions(
        tx, [assignment.userAccount_ID, current.delegatedUser_ID], 'AUTHORITY_DELEGATION_DEACTIVATED'
      )
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'AUTHORITY_DELEGATION_DEACTIVATED',
        routingUnitId: assignment.routingUnit_ID,
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { delegationId: id, assignmentId: assignment.ID }
      })
      return await this.delegation(tx, id)
    })
  }
}

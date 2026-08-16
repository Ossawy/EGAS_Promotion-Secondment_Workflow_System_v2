import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import type { AdminActor } from '../admin/admin-service.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { bool, date, optionalText, timestamp, uuid, version } from '../../shared/validation.ts'

const AUTHORITY_KINDS = ['DEPUTY', 'ASSISTANT', 'ACTING_DEPUTY', 'ACTING_ASSISTANT', 'OTHER'] as const
type AuthorityKind = typeof AUTHORITY_KINDS[number]

export type Assignment = {
  id: string
  routingUnitId: string
  userAccountId: string
  authorityKind: AuthorityKind
  authorityJobTitle: string
  isPrimary: boolean
  validFrom: string
  validTo: string | null
  isActive: boolean
  notes: string | null
  createdAt: Date | string
  updatedAt: Date | string
  version: number
}

export type Delegation = {
  id: string
  authorityAssignmentId: string
  delegatedUserId: string
  validFrom: Date | string
  validTo: Date | string | null
  isActive: boolean
  reason: string | null
  createdAt: Date | string
  version: number
}

function kind(value: unknown): AuthorityKind {
  if (typeof value !== 'string' || !(AUTHORITY_KINDS as readonly string[]).includes(value)) {
    throw new AppError(400, 'Unsupported authority kind')
  }
  return value as AuthorityKind
}

function ordered(from: string, to: string | null): void {
  if (to && new Date(to).getTime() < new Date(from).getTime()) {
    throw new AppError(400, 'validTo must not precede validFrom')
  }
}

function assignmentColumns(): string {
  return `id, routingunit_id AS "routingUnitId", useraccount_id AS "userAccountId",
    authoritykind AS "authorityKind", authorityjobtitle AS "authorityJobTitle",
    isprimary AS "isPrimary", validfrom AS "validFrom", validto AS "validTo",
    isactive AS "isActive", notes, createdat AS "createdAt", updatedat AS "updatedAt", version`
}

function delegationColumns(): string {
  return `id, authorityassignment_id AS "authorityAssignmentId", delegateduser_id AS "delegatedUserId",
    validfrom AS "validFrom", validto AS "validTo", isactive AS "isActive", reason,
    createdat AS "createdAt", version`
}

export class AuthorityService {
  constructor(private readonly pool: Pool) {}

  private async assignment(db: Queryable, id: string): Promise<Assignment> {
    const result = await db.query<Assignment>(
      `SELECT ${assignmentColumns()} FROM egas_approvingauthorityassignment WHERE id=$1`, [id]
    )
    if (!result.rows[0]) throw new AppError(404, 'Authority assignment not found')
    return result.rows[0]
  }

  private async delegation(db: Queryable, id: string): Promise<Delegation> {
    const result = await db.query<Delegation>(
      `SELECT ${delegationColumns()} FROM egas_authoritydelegation WHERE id=$1`, [id]
    )
    if (!result.rows[0]) throw new AppError(404, 'Authority delegation not found')
    return result.rows[0]
  }

  private async eligible(db: Queryable, userId: string): Promise<void> {
    const result = await db.query(
      `SELECT 1 FROM egas_useraccount a JOIN egas_useraccountrole r ON r.user_id=a.id
        WHERE a.id=$1 AND a.isactive=TRUE AND r.role='APPROVING_AUTHORITY' AND r.isactive=TRUE`, [userId]
    )
    if (!result.rows[0]) throw new AppError(400, 'Account must be active with an active APPROVING_AUTHORITY role')
  }

  private async routingUnit(db: Queryable, id: string): Promise<void> {
    const result = await db.query(`SELECT 1 FROM egas_routingunit WHERE id=$1 AND isactive=TRUE`, [id])
    if (!result.rows[0]) throw new AppError(400, 'Routing unit is missing or inactive')
  }

  private async primaryAvailable(db: Queryable, routingUnitId: string, primary: boolean, except: string | null = null): Promise<void> {
    if (!primary) return
    const result = await db.query(
      `SELECT id FROM egas_approvingauthorityassignment
        WHERE routingunit_id=$1 AND isprimary=TRUE AND isactive=TRUE AND ($2::varchar IS NULL OR id<>$2)`,
      [routingUnitId, except]
    )
    if (result.rows[0]) throw new AppError(409, 'Routing unit already has an active primary authority')
  }

  private async revokeSessions(db: Queryable, ids: string[], reason: string): Promise<void> {
    await db.query(
      `UPDATE egas_authsession SET revokedat=CURRENT_TIMESTAMP,revokedreason=$2
        WHERE user_id=ANY($1::varchar[]) AND revokedat IS NULL`, [Array.from(new Set(ids)), reason]
    )
  }

  async listAssignments(routingValue: unknown, activeValue: unknown): Promise<Assignment[]> {
    const routing = routingValue ? uuid(routingValue, 'routingUnitId') : null
    const active = activeValue === undefined ? true : bool(activeValue, 'activeOnly')
    const result = await this.pool.query<Assignment>(
      `SELECT ${assignmentColumns()} FROM egas_approvingauthorityassignment
        WHERE ($1::varchar IS NULL OR routingunit_id=$1) AND ($2::boolean=FALSE OR isactive=TRUE)
        ORDER BY routingunit_id,createdat LIMIT 100`, [routing, active]
    )
    return result.rows
  }

  async createAssignment(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Assignment> {
    const routingUnitId = uuid(input.routingUnitId, 'routingUnitId')
    const userAccountId = uuid(input.userAccountId, 'userAccountId')
    if (userAccountId === actor.userId) throw new AppError(403, 'Admins cannot configure their own authority assignment')
    const authorityKind = kind(input.authorityKind)
    const authorityJobTitle = optionalText(input.authorityJobTitle, 'authorityJobTitle', 500)
    if (!authorityJobTitle) throw new AppError(400, 'authorityJobTitle is required')
    const isPrimary = input.isPrimary === undefined ? true : bool(input.isPrimary, 'isPrimary')
    const validFrom = date(input.validFrom, 'validFrom', new Date().toISOString().slice(0, 10)) as string
    const validTo = date(input.validTo, 'validTo')
    const notes = optionalText(input.notes, 'notes', 2_000)
    ordered(validFrom, validTo)
    try {
      return await withTransaction(this.pool, async db => {
        await this.routingUnit(db, routingUnitId)
        await this.eligible(db, userAccountId)
        await this.primaryAvailable(db, routingUnitId, isPrimary)
        const id = randomUUID()
        await db.query(
          `INSERT INTO egas_approvingauthorityassignment
            (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,
             validfrom,validto,isactive,configuredby_id,notes,createdat,updatedat,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
          [id,routingUnitId,userAccountId,authorityKind,authorityJobTitle,isPrimary,validFrom,validTo,actor.userId,notes]
        )
        await this.revokeSessions(db, [userAccountId], 'AUTHORITY_ASSIGNMENT_CHANGED')
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, routingUnitId, eventType: 'AUTHORITY_ASSIGNMENT_CREATED', ...evidence,
          details: { assignmentId: id, authorityUserId: userAccountId, authorityKind, isPrimary }
        })
        return await this.assignment(db, id)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Routing unit already has an active primary authority')
      throw error
    }
  }

  async updateAssignment(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Assignment> {
    const id = uuid(input.assignmentId, 'assignmentId')
    const expected = version(input.expectedVersion)
    const authorityKind = kind(input.authorityKind)
    const authorityJobTitle = optionalText(input.authorityJobTitle, 'authorityJobTitle', 500)
    if (!authorityJobTitle) throw new AppError(400, 'authorityJobTitle is required')
    const isPrimary = bool(input.isPrimary, 'isPrimary')
    const validFrom = date(input.validFrom, 'validFrom')
    if (!validFrom) throw new AppError(400, 'validFrom is required')
    const validTo = date(input.validTo, 'validTo')
    const notes = optionalText(input.notes, 'notes', 2_000)
    ordered(validFrom, validTo)
    try {
      return await withTransaction(this.pool, async db => {
        const current = await this.assignment(db, id)
        if (current.userAccountId === actor.userId) throw new AppError(403, 'Admins cannot configure their own authority assignment')
        if (current.version !== expected) throw new AppError(409, 'Authority assignment changed; refresh')
        await this.eligible(db, current.userAccountId)
        await this.primaryAvailable(db, current.routingUnitId, isPrimary, id)
        const changed = await db.query(
          `UPDATE egas_approvingauthorityassignment
              SET authoritykind=$3,authorityjobtitle=$4,isprimary=$5,validfrom=$6,
                  validto=$7,notes=$8,updatedat=CURRENT_TIMESTAMP,version=version+1
            WHERE id=$1 AND version=$2`,
          [id,expected,authorityKind,authorityJobTitle,isPrimary,validFrom,validTo,notes]
        )
        if (changed.rowCount !== 1) throw new AppError(409, 'Authority assignment changed; refresh')
        await this.revokeSessions(db, [current.userAccountId], 'AUTHORITY_ASSIGNMENT_CHANGED')
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, routingUnitId: current.routingUnitId,
          eventType: 'AUTHORITY_ASSIGNMENT_UPDATED', ...evidence,
          details: { assignmentId: id, authorityKind, isPrimary }
        })
        return await this.assignment(db, id)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Routing unit already has an active primary authority')
      throw error
    }
  }

  async deactivateAssignment(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Assignment> {
    const id = uuid(input.assignmentId, 'assignmentId')
    const expected = version(input.expectedVersion)
    return await withTransaction(this.pool, async db => {
      const current = await this.assignment(db, id)
      if (current.userAccountId === actor.userId) throw new AppError(403, 'Admins cannot configure their own authority assignment')
      if (current.version !== expected) throw new AppError(409, 'Authority assignment changed; refresh')
      const changed = await db.query(
        `UPDATE egas_approvingauthorityassignment SET isactive=FALSE,
            updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND version=$2`, [id,expected]
      )
      if (changed.rowCount !== 1) throw new AppError(409, 'Authority assignment changed; refresh')
      await db.query(
        `UPDATE egas_authoritydelegation SET isactive=FALSE,version=version+1
          WHERE authorityassignment_id=$1 AND isactive=TRUE`, [id]
      )
      await this.revokeSessions(db, [current.userAccountId], 'AUTHORITY_ASSIGNMENT_DEACTIVATED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, routingUnitId: current.routingUnitId,
        eventType: 'AUTHORITY_ASSIGNMENT_DEACTIVATED', ...evidence, details: { assignmentId: id }
      })
      return await this.assignment(db, id)
    })
  }

  async listDelegations(assignmentValue: unknown, activeValue: unknown): Promise<Delegation[]> {
    const assignment = assignmentValue ? uuid(assignmentValue, 'assignmentId') : null
    const active = activeValue === undefined ? true : bool(activeValue, 'activeOnly')
    const result = await this.pool.query<Delegation>(
      `SELECT ${delegationColumns()} FROM egas_authoritydelegation
        WHERE ($1::varchar IS NULL OR authorityassignment_id=$1) AND ($2::boolean=FALSE OR isactive=TRUE)
        ORDER BY createdat LIMIT 100`, [assignment, active]
    )
    return result.rows
  }

  async createDelegation(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Delegation> {
    const assignmentId = uuid(input.assignmentId, 'assignmentId')
    const delegatedUserId = uuid(input.delegatedUserId, 'delegatedUserId')
    if (delegatedUserId === actor.userId) throw new AppError(403, 'Admins cannot delegate authority to themselves')
    const validFrom = timestamp(input.validFrom, 'validFrom', new Date().toISOString()) as string
    const validTo = timestamp(input.validTo, 'validTo')
    const reason = optionalText(input.reason, 'reason', 2_000)
    ordered(validFrom, validTo)
    return await withTransaction(this.pool, async db => {
      const assignment = await this.assignment(db, assignmentId)
      if (!assignment.isActive) throw new AppError(400, 'Authority assignment is inactive')
      if (assignment.userAccountId === delegatedUserId) throw new AppError(400, 'Self-delegation is prohibited')
      await this.eligible(db, assignment.userAccountId)
      await this.eligible(db, delegatedUserId)
      const id = randomUUID()
      await db.query(
        `INSERT INTO egas_authoritydelegation
          (id,authorityassignment_id,delegateduser_id,createdby_id,validfrom,validto,isactive,reason,createdat,version)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,CURRENT_TIMESTAMP,1)`,
        [id,assignmentId,delegatedUserId,actor.userId,validFrom,validTo,reason]
      )
      await this.revokeSessions(db, [assignment.userAccountId, delegatedUserId], 'AUTHORITY_DELEGATION_CHANGED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, routingUnitId: assignment.routingUnitId,
        eventType: 'AUTHORITY_DELEGATION_CREATED', ...evidence,
        details: { delegationId: id, assignmentId, delegatedUserId }
      })
      return await this.delegation(db, id)
    })
  }

  async updateDelegation(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Delegation> {
    const id = uuid(input.delegationId, 'delegationId')
    const expected = version(input.expectedVersion)
    const validFrom = timestamp(input.validFrom, 'validFrom')
    if (!validFrom) throw new AppError(400, 'validFrom is required')
    const validTo = timestamp(input.validTo, 'validTo')
    const reason = optionalText(input.reason, 'reason', 2_000)
    ordered(validFrom, validTo)
    return await withTransaction(this.pool, async db => {
      const current = await this.delegation(db, id)
      if (current.version !== expected) throw new AppError(409, 'Delegation changed; refresh')
      const assignment = await this.assignment(db, current.authorityAssignmentId)
      if (current.delegatedUserId === actor.userId) throw new AppError(403, 'Admins cannot modify delegation to themselves')
      await this.eligible(db, current.delegatedUserId)
      const changed = await db.query(
        `UPDATE egas_authoritydelegation SET validfrom=$3,validto=$4,reason=$5,version=version+1
          WHERE id=$1 AND version=$2`, [id,expected,validFrom,validTo,reason]
      )
      if (changed.rowCount !== 1) throw new AppError(409, 'Delegation changed; refresh')
      await this.revokeSessions(db, [assignment.userAccountId,current.delegatedUserId], 'AUTHORITY_DELEGATION_CHANGED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, routingUnitId: assignment.routingUnitId,
        eventType: 'AUTHORITY_DELEGATION_UPDATED', ...evidence,
        details: { delegationId: id, assignmentId: assignment.id }
      })
      return await this.delegation(db, id)
    })
  }

  async deactivateDelegation(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<Delegation> {
    const id = uuid(input.delegationId, 'delegationId')
    const expected = version(input.expectedVersion)
    return await withTransaction(this.pool, async db => {
      const current = await this.delegation(db, id)
      if (current.version !== expected) throw new AppError(409, 'Delegation changed; refresh')
      const assignment = await this.assignment(db, current.authorityAssignmentId)
      if (current.delegatedUserId === actor.userId) throw new AppError(403, 'Admins cannot modify delegation to themselves')
      const changed = await db.query(
        `UPDATE egas_authoritydelegation SET isactive=FALSE,version=version+1 WHERE id=$1 AND version=$2`,
        [id,expected]
      )
      if (changed.rowCount !== 1) throw new AppError(409, 'Delegation changed; refresh')
      await this.revokeSessions(db, [assignment.userAccountId,current.delegatedUserId], 'AUTHORITY_DELEGATION_DEACTIVATED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, routingUnitId: assignment.routingUnitId,
        eventType: 'AUTHORITY_DELEGATION_DEACTIVATED', ...evidence,
        details: { delegationId: id, assignmentId: assignment.id }
      })
      return await this.delegation(db, id)
    })
  }
}

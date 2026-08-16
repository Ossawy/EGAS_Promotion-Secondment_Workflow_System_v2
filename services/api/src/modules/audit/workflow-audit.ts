import { createHash, randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import type { AuthContext } from '../auth/types.ts'

export type AuditMetadata = Record<string, string | number | boolean | null>

export interface WorkflowAuditInput {
  requestId: string
  iterationId?: string | null
  candidateId?: string | null
  routingUnitId?: string | null
  authorityAssignmentId?: string | null
  actionCode: string
  fromStage?: string | null
  toStage?: string | null
  reason?: string | null
  metadata?: AuditMetadata
}

export async function recordWorkflowAudit(
  db: Queryable,
  actor: AuthContext,
  evidence: RequestEvidence,
  input: WorkflowAuditInput
): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('egas.audit.chain'))")
  const identity = await db.query<{ displayName: string, identifier: string }>(
    `SELECT displayname AS "displayName",COALESCE(staffidentifier,username) AS identifier
       FROM egas_useraccount WHERE id=$1`, [actor.userId]
  )
  const previous = await db.query<{ eventHash: string }>(
    `SELECT eventhash AS "eventHash" FROM egas_auditevent ORDER BY createdat DESC,id DESC LIMIT 1`
  )
  const clock = await db.query<{ createdAt: Date | string }>(`SELECT CURRENT_TIMESTAMP AS "createdAt"`)
  const id = randomUUID()
  const createdAt = new Date(clock.rows[0]!.createdAt).toISOString()
  const previousHash = previous.rows[0]?.eventHash ?? null
  const metadata: AuditMetadata = {
    correlationId: evidence.correlationId,
    userAgent: evidence.userAgent,
    ...(input.metadata ?? {})
  }
  const eventHash = createHash('sha256').update(JSON.stringify({
    previousHash, id, createdAt, actorUserId: actor.userId, actorRole: actor.activeRole,
    requestId: input.requestId, iterationId: input.iterationId ?? null,
    candidateId: input.candidateId ?? null, actionCode: input.actionCode,
    fromStage: input.fromStage ?? null, toStage: input.toStage ?? null,
    reason: input.reason ?? null, metadata
  })).digest('hex')
  await db.query(
    `INSERT INTO egas_auditevent
      (id,request_id,iteration_id,requestcandidate_id,actoruser_id,actornamesnapshot,
       actoridentifiersnapshot,actorrolesnapshot,routingunit_id,approvingauthorityassignment_id,
       actioncode,fromstage,tostage,reason,metadatajson,ipaddress,createdat,previoushash,eventhash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)`,
    [id, input.requestId, input.iterationId ?? null, input.candidateId ?? null, actor.userId,
      identity.rows[0]?.displayName ?? actor.username, identity.rows[0]?.identifier ?? actor.username,
      actor.activeRole, input.routingUnitId ?? null, input.authorityAssignmentId ?? null,
      input.actionCode, input.fromStage ?? null, input.toStage ?? null, input.reason ?? null,
      JSON.stringify(metadata), evidence.ipAddress, createdAt, previousHash, eventHash]
  )
}

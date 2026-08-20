import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'

export type SecurityEventInput = Partial<RequestEvidence> & {
  actorUserId?: string | null
  eventType: string
  routingUnitId?: string | null
  details?: Record<string, unknown>
}

export type AuditEventInput = {
  actorUserId?: string | null
  eventType: string
  subjectType?: string | null
  subjectId?: string | null
  details?: Record<string, unknown>
}

export async function recordSecurityEvent(db: Queryable, input: SecurityEventInput): Promise<void> {
  const details = {
    ...(input.details ?? {}),
    ...(input.routingUnitId !== undefined && input.routingUnitId !== null ? { routingUnitId: input.routingUnitId } : {}),
    ...(input.correlationId !== undefined && input.correlationId !== null ? { correlationId: input.correlationId } : {})
  }

  await db.query(
    `INSERT INTO security_event
      (id, actor_user_id, event_type, ip_address, user_agent, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.eventType,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(details)
    ]
  )
}

export async function recordAuditEvent(db: Queryable, input: AuditEventInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_event
      (id, actor_user_id, event_type, subject_type, subject_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.eventType,
      input.subjectType ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.details ?? {})
    ]
  )
}

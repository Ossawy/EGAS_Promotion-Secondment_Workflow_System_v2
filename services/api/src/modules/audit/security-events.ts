import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'

export type SecurityEventInput = Partial<RequestEvidence> & {
  actorUserId?: string | null
  eventType: string
  routingUnitId?: string | null
  details?: Record<string, unknown>
}

export async function recordSecurityEvent(db: Queryable, input: SecurityEventInput): Promise<void> {
  await db.query(
    `INSERT INTO egas_securityevent
      (id, actoruser_id, eventtype, ipaddress, routingunit_id, correlationid, detailsjson, createdat)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)`,
    [
      randomUUID(), input.actorUserId ?? null, input.eventType, input.ipAddress ?? null,
      input.routingUnitId ?? null, input.correlationId ?? null, JSON.stringify(input.details ?? {})
    ]
  )
}

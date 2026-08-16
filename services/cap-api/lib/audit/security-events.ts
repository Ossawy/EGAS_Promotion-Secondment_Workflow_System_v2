import { randomUUID } from 'node:crypto'
import type { Service } from '@sap/cds'

export type SecurityEventInput = {
  actorUserId?: string | null
  eventType: string
  routingUnitId?: string | null
  ipAddress?: string | null
  correlationId?: string | null
  details?: Record<string, unknown>
}

export async function recordSecurityEvent(
  db: Service,
  input: SecurityEventInput
): Promise<void> {
  await db.run(INSERT.into('egas.SecurityEvent').entries({
    ID: randomUUID(),
    actorUser_ID: input.actorUserId ?? null,
    eventType: input.eventType,
    routingUnit_ID: input.routingUnitId ?? null,
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId ?? null,
    detailsJson: input.details ?? {},
    createdAt: new Date().toISOString()
  }))
}

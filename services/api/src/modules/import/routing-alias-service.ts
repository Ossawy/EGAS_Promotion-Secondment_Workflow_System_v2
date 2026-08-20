import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { recordAuditEvent, recordSecurityEvent } from '../audit/security-events.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { bool, text, uuid } from '../../shared/validation.ts'
import { normalizeRoutingLabel } from './header-validation.ts'
import type { ImportActor } from './import-service.ts'

export interface RoutingAliasView {
  id: string
  sourceLabel: string
  routingUnit: { id: string, nameAr: string, code: string }
  isActive: boolean
  createdAt: string
}

type AliasRow = {
  id: string
  sourceLabel: string
  routingUnitId: string
  routingUnitName: string
  routingUnitCode: string
  isActive: boolean
  createdAt: string
}

const projection = `a.id, a.source_label AS "sourceLabel", a.routing_unit_id AS "routingUnitId",
  u.name_ar AS "routingUnitName", u.code AS "routingUnitCode", a.is_active AS "isActive",
  a.created_at AS "createdAt"`

function view(row: AliasRow): RoutingAliasView {
  return {
    id: row.id,
    sourceLabel: row.sourceLabel,
    routingUnit: {
      id: row.routingUnitId,
      nameAr: row.routingUnitName,
      code: row.routingUnitCode
    },
    isActive: row.isActive,
    createdAt: new Date(row.createdAt).toISOString()
  }
}

async function activeUnit(db: Queryable, idValue: unknown): Promise<{ id: string, nameAr: string, code: string }> {
  const id = uuid(idValue, 'routingUnitId')
  const result = await db.query<{ id: string, nameAr: string, code: string }>(
    `SELECT id, name_ar AS "nameAr", code FROM routing_unit WHERE id=$1 AND is_active=TRUE`,
    [id]
  )
  if (!result.rows[0]) throw new AppError(400, 'Target RoutingUnit must exist and be active')
  return result.rows[0]
}

function sourceLabel(value: unknown): string {
  const label = text(value, 'sourceLabel', 500)
  if (label === '10') throw new AppError(400, 'The blank sentinel cannot be configured as a routing alias')
  return label
}

async function rejectExactUnitAlias(db: Queryable, label: string): Promise<void> {
  const units = await db.query<{ name_ar: string }>(
    `SELECT name_ar FROM routing_unit WHERE is_active=TRUE`
  )
  const normLabel = normalizeRoutingLabel(label)
  for (const unit of units.rows) {
    if (normalizeRoutingLabel(unit.name_ar) === normLabel) {
      throw new AppError(409, 'An exact active RoutingUnit name does not require an alias', 'ALIAS_REDUNDANT')
    }
  }
}

async function aliasById(db: Queryable, id: string, lock = false): Promise<AliasRow> {
  const result = await db.query<AliasRow>(
    `SELECT ${projection} FROM routing_unit_source_alias a
     JOIN routing_unit u ON u.id=a.routing_unit_id WHERE a.id=$1${lock ? ' FOR UPDATE' : ''}`,
    [id]
  )
  if (!result.rows[0]) throw new AppError(404, 'Routing alias not found')
  return result.rows[0]
}

export class RoutingAliasService {
  constructor(private readonly pool: Pool) {}

  async list(activeOnly?: boolean): Promise<RoutingAliasView[]> {
    const result = await this.pool.query<AliasRow>(
      `SELECT ${projection} FROM routing_unit_source_alias a
       JOIN routing_unit u ON u.id=a.routing_unit_id
       WHERE ($1::boolean IS NULL OR a.is_active=$1) ORDER BY a.source_label`,
      [activeOnly ?? null]
    )
    return result.rows.map(view)
  }

  async get(idValue: unknown): Promise<RoutingAliasView> {
    const id = uuid(idValue, 'aliasId')
    const row = await aliasById(this.pool, id)
    return view(row)
  }

  async create(
    actor: ImportActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<RoutingAliasView> {
    const label = sourceLabel(input.sourceLabel)
    try {
      const id = await withTransaction(this.pool, async db => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext('egas.routing-aliases'))`)
        const target = await activeUnit(db, input.routingUnitId)
        await rejectExactUnitAlias(db, label)
        const aliasId = randomUUID()
        await db.query(
          `INSERT INTO routing_unit_source_alias
            (id, source_label, routing_unit_id, is_active)
           VALUES ($1, $2, $3, $4)`,
          [aliasId, label, target.id, input.isActive === undefined ? true : bool(input.isActive, 'isActive')]
        )
        await recordAuditEvent(db, {
          actorUserId: actor.userId,
          eventType: 'ROUTING_ALIAS_CREATED',
          subjectType: 'routing_unit_source_alias',
          subjectId: aliasId,
          details: { sourceLabel: label, routingUnitId: target.id }
        })
        await recordSecurityEvent(db, {
          actorUserId: actor.userId,
          eventType: 'ROUTING_ALIAS_CREATED',
          ...evidence,
          details: { aliasId, sourceLabel: label, routingUnitId: target.id }
        })
        return aliasId
      })
      return await this.get(id)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A routing alias for this source label already exists', 'CONFLICT')
      }
      throw error
    }
  }

  async update(
    actor: ImportActor,
    idValue: unknown,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<RoutingAliasView> {
    const id = uuid(idValue, 'aliasId')
    try {
      await withTransaction(this.pool, async db => {
        await aliasById(db, id, true)
        const target = input.routingUnitId !== undefined ? await activeUnit(db, input.routingUnitId) : null
        const label = input.sourceLabel !== undefined ? sourceLabel(input.sourceLabel) : null
        if (label) await rejectExactUnitAlias(db, label)
        const active = input.isActive !== undefined ? bool(input.isActive, 'isActive') : null

        await db.query(
          `UPDATE routing_unit_source_alias
              SET source_label = COALESCE($2, source_label),
                  routing_unit_id = COALESCE($3, routing_unit_id),
                  is_active = COALESCE($4, is_active)
            WHERE id = $1`,
          [id, label, target?.id ?? null, active]
        )

        await recordAuditEvent(db, {
          actorUserId: actor.userId,
          eventType: 'ROUTING_ALIAS_UPDATED',
          subjectType: 'routing_unit_source_alias',
          subjectId: id,
          details: { sourceLabel: label, routingUnitId: target?.id, isActive: active }
        })
        await recordSecurityEvent(db, {
          actorUserId: actor.userId,
          eventType: 'ROUTING_ALIAS_UPDATED',
          ...evidence,
          details: { aliasId: id, sourceLabel: label, routingUnitId: target?.id, isActive: active }
        })
      })
      return await this.get(id)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A routing alias for this source label already exists', 'CONFLICT')
      }
      throw error
    }
  }

  async setActive(
    actor: ImportActor,
    idValue: unknown,
    active: boolean,
    evidence: RequestEvidence
  ): Promise<RoutingAliasView> {
    const id = uuid(idValue, 'aliasId')
    await withTransaction(this.pool, async db => {
      await aliasById(db, id, true)
      await db.query(
        `UPDATE routing_unit_source_alias SET is_active = $2 WHERE id = $1`,
        [id, active]
      )
      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: active ? 'ROUTING_ALIAS_ENABLED' : 'ROUTING_ALIAS_DISABLED',
        subjectType: 'routing_unit_source_alias',
        subjectId: id,
        details: { isActive: active }
      })
      await recordSecurityEvent(db, {
        actorUserId: actor.userId,
        eventType: active ? 'ROUTING_ALIAS_ENABLED' : 'ROUTING_ALIAS_DISABLED',
        ...evidence,
        details: { aliasId: id, isActive: active }
      })
    })
    return await this.get(id)
  }
}

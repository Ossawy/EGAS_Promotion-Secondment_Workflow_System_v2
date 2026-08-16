import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { bool, optionalText, text, uuid } from '../../shared/validation.ts'
import type { ImportActor } from './import-service.ts'

export interface RoutingAliasView {
  id: string
  sourceLabel: string
  routingUnit: { id: string, nameAr: string }
  isActive: boolean
  configuredById: string | null
  configuredAt: string
  notes: string | null
}

type AliasRow = {
  id: string
  sourceLabel: string
  routingUnitId: string
  routingUnitName: string
  isActive: boolean
  configuredById: string | null
  configuredAt: string
  notes: string | null
}

const projection = `a.id,a.sourcelabel AS "sourceLabel",a.routingunit_id AS "routingUnitId",
  u.namear AS "routingUnitName",a.isactive AS "isActive",a.configuredby_id AS "configuredById",
  a.configuredat AS "configuredAt",a.notes`

function view(row: AliasRow): RoutingAliasView {
  return {
    id: row.id,
    sourceLabel: row.sourceLabel,
    routingUnit: { id: row.routingUnitId, nameAr: row.routingUnitName },
    isActive: row.isActive,
    configuredById: row.configuredById,
    configuredAt: new Date(row.configuredAt).toISOString(),
    notes: row.notes
  }
}

async function activeUnit(db: Queryable, idValue: unknown): Promise<{ id: string, nameAr: string }> {
  const id = uuid(idValue, 'routingUnitId')
  const result = await db.query<{ id: string, nameAr: string }>(
    `SELECT id,namear AS "nameAr" FROM egas_routingunit WHERE id=$1 AND isactive=TRUE`, [id]
  )
  if (!result.rows[0]) throw new AppError(400, 'Target RoutingUnit must exist and be active')
  return result.rows[0]
}

function sourceLabel(value: unknown): string {
  const label = text(value, 'sourceLabel', 300)
  if (label === '10') throw new AppError(400, 'The legacy blank sentinel cannot be configured as a routing alias')
  return label
}

async function rejectExactUnitAlias(db: Queryable, label: string): Promise<void> {
  const exact = await db.query(`SELECT 1 FROM egas_routingunit WHERE namear=$1 AND isactive=TRUE`, [label])
  if (exact.rows[0]) throw new AppError(409, 'An exact active RoutingUnit name does not require an alias')
}

async function aliasById(db: Queryable, id: string, lock = false): Promise<AliasRow> {
  const result = await db.query<AliasRow>(
    `SELECT ${projection} FROM egas_routingunitsourcealias a
     JOIN egas_routingunit u ON u.id=a.routingunit_id WHERE a.id=$1${lock ? ' FOR UPDATE' : ''}`, [id]
  )
  if (!result.rows[0]) throw new AppError(404, 'Routing alias not found')
  return result.rows[0]
}

export class RoutingAliasService {
  constructor(private readonly pool: Pool) {}

  async list(activeOnly?: boolean): Promise<RoutingAliasView[]> {
    const result = await this.pool.query<AliasRow>(
      `SELECT ${projection} FROM egas_routingunitsourcealias a
       JOIN egas_routingunit u ON u.id=a.routingunit_id
       WHERE ($1::boolean IS NULL OR a.isactive=$1) ORDER BY a.sourcelabel`, [activeOnly ?? null]
    )
    return result.rows.map(view)
  }

  async create(actor: ImportActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<RoutingAliasView> {
    const label = sourceLabel(input.sourceLabel)
    const notes = optionalText(input.notes, 'notes', 2_000)
    try {
      const id = await withTransaction(this.pool, async db => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext('egas.routing-aliases'))`)
        const target = await activeUnit(db, input.routingUnitId)
        await rejectExactUnitAlias(db, label)
        const aliasId = randomUUID()
        await db.query(
          `INSERT INTO egas_routingunitsourcealias
            (id,sourcelabel,routingunit_id,isactive,configuredby_id,configuredat,notes)
           VALUES ($1,$2,$3,TRUE,$4,CURRENT_TIMESTAMP,$5)`, [aliasId, label, target.id, actor.userId, notes]
        )
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'ROUTING_ALIAS_CREATED', ...evidence,
          details: { aliasId, routingUnitId: target.id, sourceLabel: label }
        })
        return aliasId
      })
      return view(await aliasById(this.pool, id))
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Routing source label already has an alias')
      throw error
    }
  }

  async update(
    actor: ImportActor, aliasValue: unknown, input: Record<string, unknown>, evidence: RequestEvidence
  ): Promise<RoutingAliasView> {
    const aliasId = uuid(aliasValue, 'aliasId')
    if (!Object.keys(input).some(key => ['sourceLabel','routingUnitId','isActive','notes'].includes(key))) {
      throw new AppError(400, 'At least one alias field is required')
    }
    try {
      await withTransaction(this.pool, async db => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext('egas.routing-aliases'))`)
        const current = await aliasById(db, aliasId, true)
        const label = input.sourceLabel === undefined ? current.sourceLabel : sourceLabel(input.sourceLabel)
        const target = input.routingUnitId === undefined
          ? { id: current.routingUnitId, nameAr: current.routingUnitName }
          : await activeUnit(db, input.routingUnitId)
        const active = input.isActive === undefined ? current.isActive : bool(input.isActive, 'isActive')
        const notes = input.notes === undefined ? current.notes : optionalText(input.notes, 'notes', 2_000)
        if (active) {
          await activeUnit(db, target.id)
          await rejectExactUnitAlias(db, label)
        }
        await db.query(
          `UPDATE egas_routingunitsourcealias SET sourcelabel=$2,routingunit_id=$3,isactive=$4,
             configuredby_id=$5,configuredat=CURRENT_TIMESTAMP,notes=$6 WHERE id=$1`,
          [aliasId, label, target.id, active, actor.userId, notes]
        )
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'ROUTING_ALIAS_UPDATED', ...evidence,
          details: { aliasId, routingUnitId: target.id, sourceLabel: label, isActive: active }
        })
      })
      return view(await aliasById(this.pool, aliasId))
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Routing source label already has an alias')
      throw error
    }
  }

  async deactivate(actor: ImportActor, aliasValue: unknown, evidence: RequestEvidence): Promise<RoutingAliasView> {
    const aliasId = uuid(aliasValue, 'aliasId')
    await withTransaction(this.pool, async db => {
      const current = await aliasById(db, aliasId, true)
      if (current.isActive) {
        await db.query(
          `UPDATE egas_routingunitsourcealias SET isactive=FALSE,configuredby_id=$2,
             configuredat=CURRENT_TIMESTAMP WHERE id=$1`, [aliasId, actor.userId]
        )
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'ROUTING_ALIAS_DEACTIVATED', ...evidence,
          details: { aliasId, routingUnitId: current.routingUnitId, sourceLabel: current.sourceLabel }
        })
      }
    })
    return view(await aliasById(this.pool, aliasId))
  }
}

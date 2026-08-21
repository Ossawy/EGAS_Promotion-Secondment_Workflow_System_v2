import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'
import type { StageCode } from './workflow-types.ts'

export interface ResolvedOperationalUnit {
  id: string
  kind: 'HR' | 'ORG' | 'AUTH'
  name: string
  routingUnitId: string | null
}

export async function resolveResponsibleOperationalUnit(
  db: Queryable,
  stageCode: StageCode,
  routingUnitId: string | null
): Promise<ResolvedOperationalUnit> {
  const result = await db.query<ResolvedOperationalUnit & { isActive: boolean }>(
    `SELECT id, kind, name, routing_unit_id AS "routingUnitId", is_active AS "isActive"
       FROM operational_unit`
  )

  const activeUnits = result.rows.filter(u => u.isActive)

  if (stageCode === 'P1' || stageCode === 'P3' || stageCode === 'P5' || stageCode === 'S1' || stageCode === 'S5') {
    const hrUnits = activeUnits.filter(u => u.kind === 'HR')
    if (hrUnits.length !== 1) {
      throw new AppError(500, 'Exactly one active HR operational unit is required', 'RESPONSIBLE_UNIT_UNRESOLVED')
    }
    const unit = hrUnits[0]!
    return { id: unit.id, kind: unit.kind, name: unit.name, routingUnitId: unit.routingUnitId }
  }

  if (stageCode === 'P2' || stageCode === 'P4O' || stageCode === 'S2' || stageCode === 'S4') {
    const orgUnits = activeUnits.filter(u => u.kind === 'ORG')
    if (orgUnits.length !== 1) {
      throw new AppError(500, 'Exactly one active ORG operational unit is required', 'RESPONSIBLE_UNIT_UNRESOLVED')
    }
    const unit = orgUnits[0]!
    return { id: unit.id, kind: unit.kind, name: unit.name, routingUnitId: unit.routingUnitId }
  }

  if (stageCode === 'P4' || stageCode === 'S3') {
    if (!routingUnitId) {
      throw new AppError(400, `Stage ${stageCode} requires a valid routing unit on the request`, 'ROUTING_UNIT_REQUIRED')
    }
    const authUnits = activeUnits.filter(u => u.kind === 'AUTH' && u.routingUnitId === routingUnitId)
    if (authUnits.length === 0) {
      throw new AppError(409, `No active AUTH operational unit configured for routing unit ${routingUnitId}`, 'RESPONSIBLE_UNIT_UNRESOLVED')
    }
    if (authUnits.length > 1) {
      throw new AppError(500, `Multiple active AUTH units found for routing unit ${routingUnitId}`, 'RESPONSIBLE_UNIT_AMBIGUOUS')
    }
    const unit = authUnits[0]!
    return { id: unit.id, kind: unit.kind, name: unit.name, routingUnitId: unit.routingUnitId }
  }

  throw new AppError(400, `Unknown stage code ${stageCode}`, 'INVALID_STAGE_CODE')
}

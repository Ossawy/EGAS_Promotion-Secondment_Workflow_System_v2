import type { Pool } from 'pg'
import { AppError } from '../../shared/errors.ts'
import type { AuthContext } from '../auth/types.ts'
import type { WorkflowType } from './types.ts'

type HistoryRow = {
  id: string
  requestNumber: string
  requestType: WorkflowType
  cycleYear: number
  status: string
  currentStage: string
  currentIterationNo: number
  routingUnitId: string | null
  routingUnitName: string | null
  candidateCount: number
  createdAt: Date | string
  updatedAt: Date | string
  completedAt: Date | string | null
}

export type HistoryFilters = {
  skip: number
  top: number
  requestType: WorkflowType | null
  status: string | null
  routingUnitId: string | null
  personnelNumber: string | null
  query: string | null
  from: string | null
  to: string | null
}

export class HistoryService {
  constructor(private readonly pool: Pool) {}

  async search(actor: AuthContext, filters: HistoryFilters): Promise<Record<string, unknown>[]> {
    if (!actor.activeRole || actor.activeRole === 'ADMIN') throw new AppError(403, 'Operational active role required', 'ACTIVE_ROLE_REQUIRED')
    const fromTimestamp = filters.from ? `${filters.from} 00:00:00` : null
    const toTimestamp = filters.to
      ? `${new Date(`${filters.to}T00:00:00.000Z`).toISOString().slice(0, 10)} 00:00:00` : null
    const toExclusive = toTimestamp
      ? `${new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10)} 00:00:00` : null
    const result = await this.pool.query<HistoryRow>(
      `SELECT DISTINCT r.id,r.requestnumber AS "requestNumber",r.requesttype AS "requestType",
              r.cycleyear AS "cycleYear",r.status,r.currentstage AS "currentStage",
              r.currentiterationno AS "currentIterationNo",r.routingunit_id AS "routingUnitId",
              ru.namear AS "routingUnitName",COALESCE(cc.candidatecount,0)::integer AS "candidateCount",
              r.createdat AS "createdAt",r.updatedat AS "updatedAt",r.completedat AS "completedAt"
         FROM egas_workflowrequest r
         LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
         LEFT JOIN (SELECT request_id,COUNT(*) AS candidatecount FROM egas_requestcandidate
                    WHERE removedat IS NULL GROUP BY request_id) cc ON cc.request_id=r.id
         LEFT JOIN egas_requestcandidate c ON c.request_id=r.id AND c.removedat IS NULL
         LEFT JOIN egas_stagetask scope_task ON scope_task.request_id=r.id AND scope_task.assigneduser_id=$2
           AND (($1='ORGANIZATION' AND scope_task.stagecode IN ('P2','P4O','S2','S4'))
             OR ($1='APPROVING_AUTHORITY' AND scope_task.stagecode IN ('P4','S3')))
        WHERE (
          ($1='EMPLOYEE_AFFAIRS' AND r.createdby_id=$2)
          OR ($1 IN ('ORGANIZATION','APPROVING_AUTHORITY') AND scope_task.id IS NOT NULL)
        )
          AND ($3::varchar IS NULL OR r.requesttype=$3)
          AND ($4::varchar IS NULL OR r.status=$4)
          AND ($5::varchar IS NULL OR r.routingunit_id=$5)
          AND ($6::varchar IS NULL OR c.personnelnumbersnapshot=$6)
          AND ($7::varchar IS NULL OR r.requestnumber ILIKE '%' || $7 || '%' OR c.personnelnumbersnapshot=$7)
          AND ($8::timestamp IS NULL OR r.createdat >= $8::timestamp)
          AND ($9::timestamp IS NULL OR r.createdat < $9::timestamp)
        ORDER BY r.updatedat DESC,r.id DESC LIMIT $10 OFFSET $11`,
      [actor.activeRole, actor.userId, filters.requestType, filters.status, filters.routingUnitId,
        filters.personnelNumber, filters.query, fromTimestamp, toExclusive, filters.top, filters.skip]
    )
    return result.rows.map(row => ({
      id: row.id, requestNumber: row.requestNumber, requestType: row.requestType,
      cycleYear: Number(row.cycleYear), status: row.status, currentStage: row.currentStage,
      currentIterationNo: Number(row.currentIterationNo),
      routingUnit: row.routingUnitId ? { id: row.routingUnitId, nameAr: row.routingUnitName } : null,
      candidateCount: Number(row.candidateCount), createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(), completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null
    }))
  }
}

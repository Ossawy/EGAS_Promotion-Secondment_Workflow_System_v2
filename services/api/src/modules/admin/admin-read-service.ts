import type { Pool } from 'pg'
import { AppError } from '../../shared/errors.ts'

type CountRow = {
  totalUsers: number
  activeUsers: number
  disabledUsers: number
  lockedUsers: number
  routingUnitCount: number
  coveredRoutingUnits: number
  activeAliases: number
}

type AuditRow = {
  id: string
  eventType: string
  actorUserId: string | null
  actorName: string | null
  routingUnitId: string | null
  routingUnitName: string | null
  ipAddress: string | null
  correlationId: string | null
  details: Record<string, unknown>
  createdAt: Date | string
}

function optionalFilter(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new AppError(400, `${field} is invalid`)
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maximum) throw new AppError(400, `${field} is too long`)
  return normalized
}

function optionalDate(value: unknown, field: string): string | null {
  const normalized = optionalFilter(value, field, 10)
  if (normalized === null) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(new Date(`${normalized}T00:00:00Z`).getTime())) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`)
  }
  return normalized
}

function auditView(row: AuditRow): Record<string, unknown> {
  return { ...row, createdAt: new Date(row.createdAt).toISOString() }
}

export class AdminReadService {
  constructor(private readonly pool: Pool) {}

  async overview(): Promise<Record<string, unknown>> {
    const [countsResult, snapshotResult, batchResult, activity] = await Promise.all([
      this.pool.query<CountRow>(
        `SELECT
          (SELECT COUNT(*)::integer FROM egas_useraccount) AS "totalUsers",
          (SELECT COUNT(*)::integer FROM egas_useraccount WHERE isactive=TRUE) AS "activeUsers",
          (SELECT COUNT(*)::integer FROM egas_useraccount WHERE isactive=FALSE) AS "disabledUsers",
          (SELECT COUNT(*)::integer FROM egas_useraccount WHERE lockeduntil>CURRENT_TIMESTAMP) AS "lockedUsers",
          (SELECT COUNT(*)::integer FROM egas_routingunit WHERE isactive=TRUE) AS "routingUnitCount",
          (SELECT COUNT(DISTINCT routingunit_id)::integer FROM egas_approvingauthorityassignment
            WHERE isactive=TRUE AND validfrom<=CURRENT_DATE AND (validto IS NULL OR validto>=CURRENT_DATE)) AS "coveredRoutingUnits",
          (SELECT COUNT(*)::integer FROM egas_routingunitsourcealias WHERE isactive=TRUE) AS "activeAliases"`
      ),
      this.pool.query<{ snapshotYear: number, employeeCount: number, importedAt: Date | string }>(
        `SELECT b.snapshotyear AS "snapshotYear",COUNT(s.id)::integer AS "employeeCount",b.importedat AS "importedAt"
           FROM egas_importbatch b LEFT JOIN egas_employeeannualsnapshot s ON s.importbatch_id=b.id
          WHERE b.status='ACTIVATED' GROUP BY b.id,b.snapshotyear,b.importedat
          ORDER BY b.snapshotyear DESC,b.importedat DESC,b.id LIMIT 1`
      ),
      this.pool.query<{ id: string, status: string, snapshotYear: number, blockedRows: number, warningRows: number, validRows: number, importedAt: Date | string }>(
        `SELECT id,status,snapshotyear AS "snapshotYear",blockedrows AS "blockedRows",
                warningrows AS "warningRows",validrows AS "validRows",importedat AS "importedAt"
           FROM egas_importbatch ORDER BY importedat DESC,id DESC LIMIT 1`
      ),
      this.audit({ top: 8 })
    ])
    const counts = countsResult.rows[0]!
    const snapshot = snapshotResult.rows[0]
    const latestBatch = batchResult.rows[0]
    return {
      accounts: {
        total: Number(counts.totalUsers), active: Number(counts.activeUsers),
        disabled: Number(counts.disabledUsers), locked: Number(counts.lockedUsers)
      },
      authorityCoverage: {
        covered: Number(counts.coveredRoutingUnits), total: Number(counts.routingUnitCount)
      },
      routingCoverage: { activeAliases: Number(counts.activeAliases) },
      activeSnapshot: snapshot ? {
        available: true, snapshotYear: Number(snapshot.snapshotYear), employeeCount: Number(snapshot.employeeCount),
        importedAt: new Date(snapshot.importedAt).toISOString()
      } : { available: false },
      latestBatch: latestBatch ? {
        ...latestBatch, snapshotYear: Number(latestBatch.snapshotYear), blockedRows: Number(latestBatch.blockedRows),
        warningRows: Number(latestBatch.warningRows), validRows: Number(latestBatch.validRows),
        importedAt: new Date(latestBatch.importedAt).toISOString()
      } : null,
      pilotReady: Boolean(snapshot && Number(counts.routingUnitCount) > 0 && Number(counts.coveredRoutingUnits) === Number(counts.routingUnitCount)),
      recentActivity: activity
    }
  }

  async audit(input: { skip?: number, top?: number, eventType?: unknown, actor?: unknown, from?: unknown, to?: unknown }): Promise<Record<string, unknown>[]> {
    const skip = Math.max(0, Number(input.skip ?? 0))
    const top = Math.max(1, Math.min(100, Number(input.top ?? 50)))
    const eventType = optionalFilter(input.eventType, 'eventType', 120)
    const actor = optionalFilter(input.actor, 'actor', 120)
    const from = optionalDate(input.from, 'from')
    const to = optionalDate(input.to, 'to')
    if (!Number.isSafeInteger(skip) || !Number.isSafeInteger(top)) throw new AppError(400, 'Pagination is invalid')
    if (from && to && from > to) throw new AppError(400, 'from must not follow to')
    const result = await this.pool.query<AuditRow>(
      `SELECT e.id,e.eventtype AS "eventType",e.actoruser_id AS "actorUserId",
              u.displayname AS "actorName",e.routingunit_id AS "routingUnitId",r.namear AS "routingUnitName",
              e.ipaddress AS "ipAddress",e.correlationid AS "correlationId",e.detailsjson AS details,
              e.createdat AS "createdAt"
         FROM egas_securityevent e
         LEFT JOIN egas_useraccount u ON u.id=e.actoruser_id
         LEFT JOIN egas_routingunit r ON r.id=e.routingunit_id
        WHERE ($1::varchar IS NULL OR e.eventtype=$1)
          AND ($2::varchar IS NULL OR u.username ILIKE '%' || $2 || '%' OR u.displayname ILIKE '%' || $2 || '%')
          AND ($3::date IS NULL OR e.createdat >= $3::date)
          AND ($4::date IS NULL OR e.createdat < ($4::date + INTERVAL '1 day'))
        ORDER BY e.createdat DESC,e.id DESC LIMIT $5 OFFSET $6`,
      [eventType, actor, from, to, top, skip]
    )
    return result.rows.map(auditView)
  }
}

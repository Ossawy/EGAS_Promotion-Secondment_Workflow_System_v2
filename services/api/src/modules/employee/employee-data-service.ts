import type { Pool } from 'pg'
import { AppError } from '../../shared/errors.ts'

export interface ActiveSnapshotView {
  snapshotYear: number
  importedAt: string
  employeeCount: number
}

type ActiveBatch = { id: string, snapshotYear: number, importedAt: string }

export class EmployeeDataService {
  constructor(private readonly pool: Pool) {}

  private async activeBatch(): Promise<ActiveBatch> {
    const result = await this.pool.query<ActiveBatch>(
      `SELECT id,snapshotyear AS "snapshotYear",importedat AS "importedAt"
         FROM egas_importbatch WHERE status='ACTIVATED'
        ORDER BY snapshotyear DESC,importedat DESC,id LIMIT 1`
    )
    if (!result.rows[0]) throw new AppError(409, 'No active annual employee snapshot is available', 'ACTIVE_SNAPSHOT_UNAVAILABLE')
    return result.rows[0]
  }

  async activeSnapshot(): Promise<ActiveSnapshotView> {
    const active = await this.activeBatch()
    const count = await this.pool.query<{ employeeCount: number }>(
      `SELECT COUNT(*)::integer AS "employeeCount" FROM egas_employeeannualsnapshot WHERE importbatch_id=$1`, [active.id]
    )
    return {
      snapshotYear: Number(active.snapshotYear),
      importedAt: new Date(active.importedAt).toISOString(),
      employeeCount: Number(count.rows[0]?.employeeCount ?? 0)
    }
  }

  async employee(personnelValue: unknown): Promise<Record<string, unknown>> {
    if (typeof personnelValue !== 'string') throw new AppError(400, 'Personnel Number is required')
    const personnelNumber = personnelValue.trim()
    if (personnelNumber.length < 1 || personnelNumber.length > 120) {
      throw new AppError(400, 'Personnel Number must be 1-120 characters')
    }
    const active = await this.activeBatch()
    const result = await this.pool.query<{
      snapshotYear: number, personnelNumber: string, employeeName: string, subgroup: string | null,
      sourceRoutingUnit: string | null, routingUnitId: string, routingUnitName: string,
      currentJobTitle: string | null, performanceRating: string | null,
      qualificationSource1: string | null, qualificationSource2: string | null, qualificationDate: string | null
    }>(
      `SELECT s.snapshotyear AS "snapshotYear",s.personnelnumber AS "personnelNumber",
              s.employeename AS "employeeName",s.subgroup,s.sourceroutingunit AS "sourceRoutingUnit",
              s.routingunit_id AS "routingUnitId",u.namear AS "routingUnitName",
              s.currentjobtitle AS "currentJobTitle",s.performancerating AS "performanceRating",
              s.qualificationsource1 AS "qualificationSource1",s.qualificationsource2 AS "qualificationSource2",
              s.qualificationdate AS "qualificationDate"
         FROM egas_employeeannualsnapshot s
         JOIN egas_routingunit u ON u.id=s.routingunit_id AND u.isactive=TRUE
        WHERE s.importbatch_id=$1 AND s.personnelnumber=$2`, [active.id, personnelNumber]
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'Employee was not found in the active annual snapshot', 'EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT')
    return {
      snapshotYear: Number(row.snapshotYear),
      personnelNumber: row.personnelNumber,
      employeeName: row.employeeName,
      subgroup: row.subgroup,
      sourceRoutingUnit: row.sourceRoutingUnit,
      routingUnit: { id: row.routingUnitId, nameAr: row.routingUnitName },
      currentJobTitle: row.currentJobTitle,
      performanceRating: row.performanceRating,
      qualificationSource1: row.qualificationSource1,
      qualificationSource2: row.qualificationSource2,
      qualificationDate: row.qualificationDate,
      warnings: {
        performanceRequiresAttention: row.performanceRating === 'جيد',
        performanceMissing: row.performanceRating === null
      }
    }
  }
}

import cds, { type Service } from '@sap/cds'
import type {
  EmployeeDataProvider,
  EmployeeSnapshotRecord
} from './employee-data-provider.js'

type ImportBatchRow = {
  ID: string
  snapshotYear: number
}

type SnapshotRow = {
  ID: string
  employee_ID: string
  snapshotYear: number
  personnelNumber: string
  employeeName: string
  subgroup: string | null
  routingUnit_ID: string | null
  sourceRoutingUnit: string | null
  currentJobTitle: string | null
  performanceRating: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
}

export class LocalEmployeeDataProvider implements EmployeeDataProvider {
  constructor(private readonly injectedDb?: Service) {}

  async getActiveSnapshotYear(): Promise<number | null> {
    const batch = await this.activeBatch()
    return batch?.snapshotYear ?? null
  }

  async findEligibleEmployee(
    personnelNumber: string,
    year?: number
  ): Promise<EmployeeSnapshotRecord | null> {
    const normalized = personnelNumber.trim()
    if (!normalized || normalized.length > 120) return null

    const batch = await this.activeBatch(year)
    if (!batch) return null

    const db = this.injectedDb ?? await cds.connect.to('db')
    const row = await db.run(
      SELECT.one.from('egas.EmployeeAnnualSnapshot')
        .where({ importBatch_ID: batch.ID, personnelNumber: normalized })
    ) as SnapshotRow | undefined

    // An unmapped routing label is deliberately ineligible for workflow routing.
    if (!row?.routingUnit_ID) return null

    return {
      id: row.ID,
      employeeId: row.employee_ID,
      snapshotYear: row.snapshotYear,
      personnelNumber: row.personnelNumber,
      employeeName: row.employeeName,
      subgroup: row.subgroup,
      routingUnitId: row.routingUnit_ID,
      sourceRoutingUnit: row.sourceRoutingUnit,
      currentJobTitle: row.currentJobTitle,
      performanceRating: row.performanceRating,
      qualificationSource1: row.qualificationSource1,
      qualificationSource2: row.qualificationSource2,
      qualificationDate: row.qualificationDate
    }
  }

  private async activeBatch(year?: number): Promise<ImportBatchRow | null> {
    const db = this.injectedDb ?? await cds.connect.to('db')
    const where = year === undefined
      ? { status: 'ACTIVATED' }
      : { status: 'ACTIVATED', snapshotYear: year }

    const rows = await db.run(
      SELECT.from('egas.ImportBatch')
        .columns('ID', 'snapshotYear')
        .where(where)
        .orderBy('importedAt desc')
        .limit(1)
    ) as ImportBatchRow[]

    return rows[0] ?? null
  }
}

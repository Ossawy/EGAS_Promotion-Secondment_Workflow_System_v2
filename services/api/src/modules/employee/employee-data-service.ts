import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'

export interface ActiveSnapshotView {
  snapshotYear: number
  activatedAt: string
  employeeCount: number
}

type ActiveBatch = {
  id: string
  snapshotYear: number
  activatedAt: string
}

export interface WorkflowEmployeeSnapshot {
  snapshotId: string
  employeeId: string
  importBatchId: string
  snapshotYear: number
  personnelNumber: string
  employeeName: string
  employeeGroup: string | null
  subgroup: string | null
  sourceRoutingLabel: string | null
  routingUnitId: string
  routingUnitName: string
  routingUnitCode: string
  currentJobTitle: string | null
  lastPromotionDate: string | null
  experienceStartDate: string | null
  performanceRating: string | null
  performanceReportYear: number
  joiningDate: string | null
  experienceYears: number | null
  experienceMonths: number | null
  experienceDays: number | null
  experienceReferenceDate: string
  currentJobStartDate: string | null
  currentJobTenureYears: number | null
  currentJobTenureMonths: number | null
  currentJobTenureDays: number | null
  currentJobTenureReferenceDate: string
  originalQualificationSource: string | null
  originalQualificationCertificate: string | null
  originalQualificationDate: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
  employeeData: Record<string, unknown>
}

type SnapshotRow = {
  snapshotId: string
  employeeId: string
  importBatchId: string
  snapshotYear: number
  personnelNumber: string
  routingUnitId: string | null
  routingUnitName: string | null
  routingUnitCode: string | null
  routingUnitActive: boolean | null
  employeeData: Record<string, unknown>
}

export class EmployeeDataService {
  constructor(private readonly db: Queryable) {}

  private async activeBatch(year?: number): Promise<ActiveBatch> {
    const result = await this.db.query<ActiveBatch>(
      `SELECT id, snapshot_year AS "snapshotYear", activated_at AS "activatedAt"
         FROM import_batch
        WHERE status = 'ACTIVATED'
          AND ($1::integer IS NULL OR snapshot_year = $1)
        ORDER BY snapshot_year DESC, activated_at DESC, id LIMIT 1`,
      [year ?? null]
    )
    if (!result.rows[0]) {
      throw new AppError(
        409,
        year ? `No active annual employee snapshot is available for year ${year}` : 'No active annual employee snapshot is available',
        'ACTIVE_SNAPSHOT_UNAVAILABLE'
      )
    }
    return result.rows[0]
  }

  async activeSnapshot(year?: number): Promise<ActiveSnapshotView> {
    const active = await this.activeBatch(year)
    const count = await this.db.query<{ employeeCount: number }>(
      `SELECT COUNT(*)::integer AS "employeeCount" FROM employee_annual_snapshot WHERE import_batch_id = $1`,
      [active.id]
    )
    return {
      snapshotYear: Number(active.snapshotYear),
      activatedAt: new Date(active.activatedAt).toISOString(),
      employeeCount: Number(count.rows[0]?.employeeCount ?? 0)
    }
  }

  async employeeForWorkflow(personnelValue: unknown, year?: number): Promise<WorkflowEmployeeSnapshot> {
    if (typeof personnelValue !== 'string') throw new AppError(400, 'Personnel Number is required')
    const personnelNumber = personnelValue.trim()
    if (personnelNumber.length < 1 || personnelNumber.length > 120) {
      throw new AppError(400, 'Personnel Number must be 1-120 characters')
    }

    const active = await this.activeBatch(year)
    const result = await this.db.query<SnapshotRow>(
      `SELECT s.id AS "snapshotId",
              s.employee_id AS "employeeId",
              s.import_batch_id AS "importBatchId",
              s.snapshot_year AS "snapshotYear",
              s.personnel_number AS "personnelNumber",
              s.routing_unit_id AS "routingUnitId",
              u.name_ar AS "routingUnitName",
              u.code AS "routingUnitCode",
              u.is_active AS "routingUnitActive",
              s.employee_data AS "employeeData"
         FROM employee_annual_snapshot s
         LEFT JOIN routing_unit u ON u.id = s.routing_unit_id
        WHERE s.import_batch_id = $1 AND s.personnel_number = $2`,
      [active.id, personnelNumber]
    )
    const row = result.rows[0]
    if (!row) {
      throw new AppError(404, 'Employee was not found in the active annual snapshot', 'EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT')
    }
    if (!row.routingUnitId || !row.routingUnitName || !row.routingUnitActive) {
      throw new AppError(409, 'Employee routing is unresolved or inactive in the annual snapshot', 'EMPLOYEE_ROUTING_UNRESOLVED')
    }

    const data = (row.employeeData ?? {}) as Record<string, unknown>
    const qualSource = (data.originalQualificationSource as string) ?? null
    const qualCert = (data.originalQualificationCertificate as string) ?? null
    const qualDate = (data.originalQualificationDate as string) ?? null

    return {
      snapshotId: row.snapshotId,
      employeeId: row.employeeId,
      importBatchId: row.importBatchId,
      snapshotYear: Number(row.snapshotYear),
      personnelNumber: row.personnelNumber,
      employeeName: String(data.employeeName ?? ''),
      employeeGroup: (data.employeeGroup as string) ?? null,
      subgroup: (data.employeeSubgroup as string) ?? null,
      sourceRoutingLabel: (data.sourceRoutingLabel as string) ?? null,
      routingUnitId: row.routingUnitId,
      routingUnitName: row.routingUnitName,
      routingUnitCode: row.routingUnitCode ?? '',
      currentJobTitle: (data.currentJobTitle as string) ?? null,
      lastPromotionDate: (data.lastPromotionDate as string) ?? null,
      experienceStartDate: (data.experienceStartDate as string) ?? null,
      performanceRating: (data.performanceRating as string) ?? null,
      performanceReportYear: Number(data.performanceReportYear ?? row.snapshotYear),
      joiningDate: (data.joiningDate as string) ?? null,
      experienceYears: data.experienceYears !== undefined && data.experienceYears !== null ? Number(data.experienceYears) : null,
      experienceMonths: data.experienceMonths !== undefined && data.experienceMonths !== null ? Number(data.experienceMonths) : null,
      experienceDays: data.experienceDays !== undefined && data.experienceDays !== null ? Number(data.experienceDays) : null,
      experienceReferenceDate: String(data.experienceReferenceDate ?? `${row.snapshotYear}-01-01`),
      currentJobStartDate: (data.currentJobStartDate as string) ?? null,
      currentJobTenureYears: data.currentJobTenureYears !== undefined && data.currentJobTenureYears !== null ? Number(data.currentJobTenureYears) : null,
      currentJobTenureMonths: data.currentJobTenureMonths !== undefined && data.currentJobTenureMonths !== null ? Number(data.currentJobTenureMonths) : null,
      currentJobTenureDays: data.currentJobTenureDays !== undefined && data.currentJobTenureDays !== null ? Number(data.currentJobTenureDays) : null,
      currentJobTenureReferenceDate: String(data.currentJobTenureReferenceDate ?? `${row.snapshotYear}-07-01`),
      originalQualificationSource: qualSource,
      originalQualificationCertificate: qualCert,
      originalQualificationDate: qualDate,
      qualificationSource1: qualSource,
      qualificationSource2: qualCert,
      qualificationDate: qualDate,
      employeeData: data
    }
  }

  async employee(personnelValue: unknown, year?: number): Promise<Record<string, unknown>> {
    const row = await this.employeeForWorkflow(personnelValue, year)
    return {
      snapshotId: row.snapshotId,
      snapshotYear: row.snapshotYear,
      personnelNumber: row.personnelNumber,
      employeeName: row.employeeName,
      employeeGroup: row.employeeGroup,
      subgroup: row.subgroup,
      sourceRoutingUnit: row.sourceRoutingLabel,
      routingUnit: {
        id: row.routingUnitId,
        nameAr: row.routingUnitName,
        code: row.routingUnitCode
      },
      currentJobTitle: row.currentJobTitle,
      lastPromotionDate: row.lastPromotionDate,
      experienceStartDate: row.experienceStartDate,
      performanceRating: row.performanceRating,
      performanceReportYear: row.performanceReportYear,
      joiningDate: row.joiningDate,
      experience: {
        years: row.experienceYears,
        months: row.experienceMonths,
        days: row.experienceDays,
        referenceDate: row.experienceReferenceDate
      },
      currentJobTenure: {
        years: row.currentJobTenureYears,
        months: row.currentJobTenureMonths,
        days: row.currentJobTenureDays,
        referenceDate: row.currentJobTenureReferenceDate
      },
      currentJobStartDate: row.currentJobStartDate,
      qualification: {
        source: row.originalQualificationSource,
        certificate: row.originalQualificationCertificate,
        date: row.originalQualificationDate
      },
      warnings: {
        performanceRequiresAttention: false,
        performanceMissing: row.performanceRating === null
      }
    }
  }
}

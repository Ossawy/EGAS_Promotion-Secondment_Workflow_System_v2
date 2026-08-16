import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import { inspectAnnualWorkbook } from './workbook-inspector.ts'
import {
  applyDuplicatePersonnelValidation, normalizeStagingRow, rowsFromStoredRaw,
  type NormalizedStagingRow, type RoutingIndex, type RoutingTarget, type ValidationMessage
} from './normalization.ts'

export interface ImportActor { userId: string, username: string }

export interface ImportBatchSummary {
  id: string
  snapshotYear: number
  sourceFilename: string
  sourceSha256: string | null
  importedBy: { id: string, username: string, displayName: string } | null
  importedAt: string
  headerSchemaValidated: boolean
  detectedHeaders: string[]
  status: string
  totalRows: number
  validRows: number
  warningRows: number
  blockedRows: number
}

export interface UnmappedRoutingLabel { sourceLabel: string, rowCount: number }
export interface ImportResult extends ImportBatchSummary { unmappedRoutingLabels: UnmappedRoutingLabel[] }

type BatchRow = {
  id: string
  snapshotYear: number
  sourceFilename: string
  sourceSha256: string | null
  importedById: string | null
  importedByUsername: string | null
  importedByDisplayName: string | null
  importedAt: string
  headerSchemaValidated: boolean
  detectedHeaders: string[]
  status: string
  totalRows: number
  validRows: number
  warningRows: number
  blockedRows: number
}

type StoredStagingRow = {
  id: string
  sourceRowNumber: number
  raw: Record<string, string | number | boolean | null>
}

function batchProjection(alias = 'b'): string {
  return `${alias}.id, ${alias}.snapshotyear AS "snapshotYear", ${alias}.sourcefilename AS "sourceFilename",
    ${alias}.sourcesha256 AS "sourceSha256", ${alias}.importedby_id AS "importedById",
    u.username AS "importedByUsername", u.displayname AS "importedByDisplayName",
    ${alias}.importedat AS "importedAt", ${alias}.headerschemavalidated AS "headerSchemaValidated",
    ${alias}.detectedheadersjson AS "detectedHeaders", ${alias}.status,
    ${alias}.totalrows AS "totalRows", ${alias}.validrows AS "validRows",
    ${alias}.warningrows AS "warningRows", ${alias}.blockedrows AS "blockedRows"`
}

function summary(row: BatchRow): ImportBatchSummary {
  return {
    id: row.id,
    snapshotYear: Number(row.snapshotYear),
    sourceFilename: row.sourceFilename,
    sourceSha256: row.sourceSha256,
    importedBy: row.importedById ? {
      id: row.importedById,
      username: row.importedByUsername ?? '',
      displayName: row.importedByDisplayName ?? ''
    } : null,
    importedAt: new Date(row.importedAt).toISOString(),
    headerSchemaValidated: row.headerSchemaValidated,
    detectedHeaders: row.detectedHeaders,
    status: row.status,
    totalRows: Number(row.totalRows),
    validRows: Number(row.validRows),
    warningRows: Number(row.warningRows),
    blockedRows: Number(row.blockedRows)
  }
}

function counts(rows: readonly NormalizedStagingRow[]): Pick<ImportBatchSummary, 'totalRows'|'validRows'|'warningRows'|'blockedRows'> {
  return {
    totalRows: rows.length,
    validRows: rows.filter(row => row.validationStatus === 'VALID').length,
    warningRows: rows.filter(row => row.validationStatus === 'WARNING').length,
    blockedRows: rows.filter(row => row.validationStatus === 'BLOCKED').length
  }
}

async function loadRoutingIndex(db: Queryable): Promise<RoutingIndex> {
  const units = await db.query<RoutingTarget>(
    `SELECT id,namear AS "nameAr" FROM egas_routingunit WHERE isactive=TRUE`
  )
  const aliases = await db.query<{ sourceLabel: string, id: string, nameAr: string }>(
    `SELECT a.sourcelabel AS "sourceLabel",u.id,u.namear AS "nameAr"
       FROM egas_routingunitsourcealias a
       JOIN egas_routingunit u ON u.id=a.routingunit_id
      WHERE a.isactive=TRUE AND u.isactive=TRUE`
  )
  return {
    unitsByName: new Map(units.rows.map(unit => [unit.nameAr, unit])),
    aliasesByLabel: new Map(aliases.rows.map(alias => [alias.sourceLabel, { id: alias.id, nameAr: alias.nameAr }]))
  }
}

async function resolveOperator(db: Queryable, usernameValue: unknown): Promise<ImportActor> {
  if (typeof usernameValue !== 'string' || usernameValue.trim().length < 1 || usernameValue.trim().length > 120) {
    throw new AppError(400, 'operator must be an application username')
  }
  const result = await db.query<ImportActor>(
    `SELECT a.id AS "userId",a.username
       FROM egas_useraccount a
       JOIN egas_useraccountrole r ON r.user_id=a.id
      WHERE a.username=$1 AND a.isactive=TRUE AND r.isactive=TRUE AND r.role='ADMIN'
      LIMIT 1`, [usernameValue.trim()]
  )
  if (!result.rows[0]) throw new AppError(403, 'An active ADMIN operator account is required', 'IMPORT_OPERATOR_REJECTED')
  return result.rows[0]
}

async function insertStagingRow(db: Queryable, batchId: string, row: NormalizedStagingRow): Promise<void> {
  await db.query(
    `INSERT INTO egas_employeeimportstagingrow
      (id,importbatch_id,sourcerownumber,rawjson,personnelnumber,employeename,subgroup,
       sourceroutingunit,currentjobtitle,performancerating,qualificationsource1,
       qualificationsource2,qualificationdate,mappedroutingunit_id,validationstatus,validationmessagesjson)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
    [randomUUID(), batchId, row.sourceRowNumber, JSON.stringify(row.raw), row.personnelNumber,
      row.employeeName, row.subgroup, row.sourceRoutingUnit, row.currentJobTitle, row.performanceRating,
      row.qualificationSource1, row.qualificationSource2, row.qualificationDate,
      row.mappedRoutingUnitId, row.validationStatus, JSON.stringify(row.validationMessages)]
  )
}

export class ImportService {
  constructor(private readonly pool: Pool) {}

  async operator(username: unknown): Promise<ImportActor> {
    return await resolveOperator(this.pool, username)
  }

  async stageWorkbook(
    file: string, year: number, operatorUsername: unknown, evidence: RequestEvidence
  ): Promise<ImportResult> {
    const actor = await resolveOperator(this.pool, operatorUsername)
    let inspection
    try {
      inspection = await inspectAnnualWorkbook(file, year)
    } catch (error) {
      await withTransaction(this.pool, async db => {
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'IMPORT_BATCH_VALIDATION_FAILED', ...evidence,
          details: {
            snapshotYear: year,
            sourceFilename: path.basename(file).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500),
            reasonCode: error instanceof AppError ? error.code : 'WORKBOOK_REJECTED'
          }
        })
      })
      throw error
    }

    const batch = await withTransaction(this.pool, async db => {
      const batchId = randomUUID()
      await db.query(
        `INSERT INTO egas_importbatch
          (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,
           importedby_id,importedat,status,totalrows,validrows,warningrows,blockedrows)
         VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6,CURRENT_TIMESTAMP,'STAGED',0,0,0,0)`,
        [batchId, year, inspection.basename, inspection.sourceSha256,
          JSON.stringify(inspection.headers.normalizedHeaders), actor.userId]
      )
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'IMPORT_BATCH_STAGED', ...evidence,
        details: { batchId, snapshotYear: year, sourceSha256: inspection.sourceSha256, totalRows: inspection.rowCount }
      })

      const routing = await loadRoutingIndex(db)
      const normalized = inspection.rows.map(row => normalizeStagingRow(row, year, routing))
      applyDuplicatePersonnelValidation(normalized)
      for (const row of normalized) await insertStagingRow(db, batchId, row)
      const totals = counts(normalized)
      await db.query(
        `UPDATE egas_importbatch SET status='VALIDATED',totalrows=$2,validrows=$3,warningrows=$4,blockedrows=$5
          WHERE id=$1 AND status='STAGED'`,
        [batchId, totals.totalRows, totals.validRows, totals.warningRows, totals.blockedRows]
      )
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'IMPORT_BATCH_VALIDATION_COMPLETED', ...evidence,
        details: { batchId, snapshotYear: year, ...totals }
      })
      return batchId
    })
    return await this.getResult(batch)
  }

  async revalidate(batchValue: unknown, actor: ImportActor, evidence: RequestEvidence): Promise<ImportResult> {
    const batchId = uuid(batchValue, 'batchId')
    await withTransaction(this.pool, async db => {
      const batch = await db.query<{ snapshotYear: number, status: string }>(
        `SELECT snapshotyear AS "snapshotYear",status FROM egas_importbatch WHERE id=$1 FOR UPDATE`, [batchId]
      )
      const current = batch.rows[0]
      if (!current) throw new AppError(404, 'Import batch not found')
      if (current.status === 'ACTIVATED') throw new AppError(409, 'Activated import batches cannot be revalidated')
      if (current.status !== 'VALIDATED') throw new AppError(409, 'Only a validated staged batch can be revalidated')
      const stored = await db.query<StoredStagingRow>(
        `SELECT id,sourcerownumber AS "sourceRowNumber",rawjson AS raw
           FROM egas_employeeimportstagingrow WHERE importbatch_id=$1 ORDER BY sourcerownumber`, [batchId]
      )
      const routing = await loadRoutingIndex(db)
      const normalized = rowsFromStoredRaw(stored.rows).map(row => normalizeStagingRow(row, Number(current.snapshotYear), routing))
      applyDuplicatePersonnelValidation(normalized)
      for (let index = 0; index < normalized.length; index += 1) {
        const row = normalized[index]!
        await db.query(
          `UPDATE egas_employeeimportstagingrow SET personnelnumber=$2,employeename=$3,subgroup=$4,
             sourceroutingunit=$5,currentjobtitle=$6,performancerating=$7,qualificationsource1=$8,
             qualificationsource2=$9,qualificationdate=$10,mappedroutingunit_id=$11,
             validationstatus=$12,validationmessagesjson=$13::jsonb WHERE id=$1`,
          [stored.rows[index]!.id, row.personnelNumber, row.employeeName, row.subgroup, row.sourceRoutingUnit,
            row.currentJobTitle, row.performanceRating, row.qualificationSource1, row.qualificationSource2,
            row.qualificationDate, row.mappedRoutingUnitId, row.validationStatus, JSON.stringify(row.validationMessages)]
        )
      }
      const totals = counts(normalized)
      await db.query(
        `UPDATE egas_importbatch SET totalrows=$2,validrows=$3,warningrows=$4,blockedrows=$5 WHERE id=$1`,
        [batchId, totals.totalRows, totals.validRows, totals.warningRows, totals.blockedRows]
      )
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'IMPORT_BATCH_REVALIDATED', ...evidence,
        details: { batchId, snapshotYear: Number(current.snapshotYear), ...totals }
      })
    })
    return await this.getResult(batchId)
  }

  private async invalidActivation(actor: ImportActor, batchId: string, reasonCode: string, evidence: RequestEvidence): Promise<void> {
    try {
      await withTransaction(this.pool, async db => {
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'IMPORT_BATCH_ACTIVATION_REJECTED', ...evidence,
          details: { batchId, reasonCode }
        })
      })
    } catch {
      // Audit failure must not replace the original safe activation rejection.
    }
  }

  async activate(batchValue: unknown, actor: ImportActor, evidence: RequestEvidence): Promise<ImportResult> {
    const batchId = uuid(batchValue, 'batchId')
    try {
      await withTransaction(this.pool, async db => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext('egas.annual-import.activation'))`)
        const migration = await db.query(
          `SELECT 1 FROM egas_schemamigration WHERE version='002_phase2b_annual_snapshot_integrity'`
        )
        if (!migration.rows[0]) {
          throw new AppError(409, 'Phase 2B database integrity migration must be applied before activation', 'IMPORT_MIGRATION_REQUIRED')
        }
        const batchResult = await db.query<{
          snapshotYear: number, status: string, headerSchemaValidated: boolean,
          totalRows: number, validRows: number, warningRows: number, blockedRows: number
        }>(
          `SELECT snapshotyear AS "snapshotYear",status,headerschemavalidated AS "headerSchemaValidated",
                  totalrows AS "totalRows",validrows AS "validRows",warningrows AS "warningRows",blockedrows AS "blockedRows"
             FROM egas_importbatch WHERE id=$1 FOR UPDATE`, [batchId]
        )
        const batch = batchResult.rows[0]
        if (!batch) throw new AppError(404, 'Import batch not found', 'IMPORT_BATCH_NOT_FOUND')
        if (batch.status === 'ACTIVATED') throw new AppError(409, 'Import batch is already activated', 'IMPORT_ALREADY_ACTIVATED')
        if (batch.status !== 'VALIDATED' || !batch.headerSchemaValidated) {
          throw new AppError(409, 'Import batch has not completed approved validation', 'IMPORT_NOT_VALIDATED')
        }
        const totalRows = Number(batch.totalRows)
        if (totalRows < 1 || Number(batch.blockedRows) !== 0
          || Number(batch.validRows) + Number(batch.warningRows) !== totalRows) {
          throw new AppError(409, 'A full annual snapshot requires zero blocked rows', 'IMPORT_BLOCKED_ROWS')
        }
        const active = await db.query(
          `SELECT 1 FROM egas_importbatch WHERE snapshotyear=$1 AND status='ACTIVATED' AND id<>$2 LIMIT 1`,
          [Number(batch.snapshotYear), batchId]
        )
        if (active.rows[0]) throw new AppError(409, 'An annual snapshot is already activated for this year', 'IMPORT_YEAR_ACTIVE')
        const existingSnapshots = await db.query(
          `SELECT 1 FROM egas_employeeannualsnapshot WHERE snapshotyear=$1 LIMIT 1`, [Number(batch.snapshotYear)]
        )
        if (existingSnapshots.rows[0]) throw new AppError(409, 'Annual snapshots for this year already exist', 'IMPORT_YEAR_IMMUTABLE')

        const rows = await db.query<{
          sourceRowNumber: number, personnelNumber: string, employeeName: string, subgroup: string | null,
          sourceRoutingUnit: string, currentJobTitle: string | null, performanceRating: string | null,
          qualificationSource1: string | null, qualificationSource2: string | null,
          qualificationDate: string | null, mappedRoutingUnitId: string, validationStatus: string
        }>(
          `SELECT sourcerownumber AS "sourceRowNumber",personnelnumber AS "personnelNumber",
                  employeename AS "employeeName",subgroup,sourceroutingunit AS "sourceRoutingUnit",
                  currentjobtitle AS "currentJobTitle",performancerating AS "performanceRating",
                  qualificationsource1 AS "qualificationSource1",qualificationsource2 AS "qualificationSource2",
                  qualificationdate AS "qualificationDate",mappedroutingunit_id AS "mappedRoutingUnitId",
                  validationstatus AS "validationStatus"
             FROM egas_employeeimportstagingrow WHERE importbatch_id=$1 ORDER BY sourcerownumber`, [batchId]
        )
        if (rows.rows.length !== totalRows || rows.rows.some(row =>
          !row.personnelNumber || !row.employeeName || !row.mappedRoutingUnitId
          || (row.validationStatus !== 'VALID' && row.validationStatus !== 'WARNING')
        )) {
          throw new AppError(409, 'Staging rows do not satisfy full-snapshot activation invariants', 'IMPORT_STAGING_INCONSISTENT')
        }

        for (const row of rows.rows) {
          let employee = await db.query<{ id: string }>(
            `SELECT id FROM egas_employee WHERE personnelnumber=$1`, [row.personnelNumber]
          )
          if (!employee.rows[0]) {
            const employeeId = randomUUID()
            try {
              await db.query(
                `INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,$2,CURRENT_TIMESTAMP)`,
                [employeeId, row.personnelNumber]
              )
              employee = { ...employee, rows: [{ id: employeeId }] }
            } catch (error) {
              if (!isUniqueViolation(error)) throw error
              employee = await db.query<{ id: string }>(
                `SELECT id FROM egas_employee WHERE personnelnumber=$1`, [row.personnelNumber]
              )
            }
          }
          await db.query(
            `INSERT INTO egas_employeeannualsnapshot
              (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,subgroup,
               sourceroutingunit,routingunit_id,currentjobtitle,performancerating,qualificationsource1,
               qualificationsource2,qualificationdate,sourcerownumber,createdat)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP)`,
            [randomUUID(), employee.rows[0]!.id, batchId, Number(batch.snapshotYear), row.personnelNumber,
              row.employeeName, row.subgroup, row.sourceRoutingUnit, row.mappedRoutingUnitId,
              row.currentJobTitle, row.performanceRating, row.qualificationSource1, row.qualificationSource2,
              row.qualificationDate, Number(row.sourceRowNumber)]
          )
        }
        const changed = await db.query(
          `UPDATE egas_importbatch SET status='ACTIVATED' WHERE id=$1 AND status='VALIDATED'`, [batchId]
        )
        if (changed.rowCount !== 1) throw new AppError(409, 'Import batch activation raced with another operation', 'IMPORT_ACTIVATION_RACE')
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'IMPORT_BATCH_ACTIVATED', ...evidence,
          details: { batchId, snapshotYear: Number(batch.snapshotYear), totalRows }
        })
      })
    } catch (error) {
      await this.invalidActivation(
        actor, batchId, error instanceof AppError ? error.code : 'IMPORT_ACTIVATION_FAILED', evidence
      )
      throw error
    }
    return await this.getResult(batchId)
  }

  async listBatches(skip: number, top: number, year?: number, status?: string): Promise<ImportBatchSummary[]> {
    const result = await this.pool.query<BatchRow>(
      `SELECT ${batchProjection()} FROM egas_importbatch b
       LEFT JOIN egas_useraccount u ON u.id=b.importedby_id
       WHERE ($1::integer IS NULL OR b.snapshotyear=$1)
         AND ($2::varchar IS NULL OR b.status=$2)
       ORDER BY b.importedat DESC,b.id LIMIT $3 OFFSET $4`, [year ?? null, status ?? null, top, skip]
    )
    return result.rows.map(summary)
  }

  async getBatch(batchValue: unknown): Promise<ImportBatchSummary & { issues: Array<{ code: string, rowCount: number }> }> {
    const batchId = uuid(batchValue, 'batchId')
    const result = await this.pool.query<BatchRow>(
      `SELECT ${batchProjection()} FROM egas_importbatch b
       LEFT JOIN egas_useraccount u ON u.id=b.importedby_id WHERE b.id=$1`, [batchId]
    )
    if (!result.rows[0]) throw new AppError(404, 'Import batch not found')
    const messages = await this.pool.query<{ messages: ValidationMessage[] }>(
      `SELECT validationmessagesjson AS messages FROM egas_employeeimportstagingrow WHERE importbatch_id=$1`, [batchId]
    )
    const issueCounts = new Map<string, number>()
    for (const row of messages.rows) {
      for (const message of row.messages) issueCounts.set(message.code, (issueCounts.get(message.code) ?? 0) + 1)
    }
    return {
      ...summary(result.rows[0]),
      issues: [...issueCounts].map(([code, rowCount]) => ({ code, rowCount })).sort((a, b) => a.code.localeCompare(b.code))
    }
  }

  async listRows(batchValue: unknown, skip: number, top: number, status?: string): Promise<Array<Record<string, unknown>>> {
    const batchId = uuid(batchValue, 'batchId')
    await this.getBatch(batchId)
    const result = await this.pool.query<{
      sourceRowNumber: number, sourceRoutingUnit: string | null, mappedRoutingUnitId: string | null,
      mappedRoutingUnitName: string | null, validationStatus: string, validationMessages: ValidationMessage[]
    }>(
      `SELECT s.sourcerownumber AS "sourceRowNumber",s.sourceroutingunit AS "sourceRoutingUnit",
              s.mappedroutingunit_id AS "mappedRoutingUnitId",u.namear AS "mappedRoutingUnitName",
              s.validationstatus AS "validationStatus",s.validationmessagesjson AS "validationMessages"
         FROM egas_employeeimportstagingrow s LEFT JOIN egas_routingunit u ON u.id=s.mappedroutingunit_id
        WHERE s.importbatch_id=$1 AND ($2::varchar IS NULL OR s.validationstatus=$2)
        ORDER BY s.sourcerownumber LIMIT $3 OFFSET $4`, [batchId, status ?? null, top, skip]
    )
    return result.rows
  }

  async unmappedRoutingLabels(batchValue: unknown): Promise<UnmappedRoutingLabel[]> {
    const batchId = uuid(batchValue, 'batchId')
    await this.getBatch(batchId)
    const result = await this.pool.query<{ sourceLabel: string, rowCount: number }>(
      `SELECT sourceroutingunit AS "sourceLabel",COUNT(*)::integer AS "rowCount"
         FROM egas_employeeimportstagingrow
        WHERE importbatch_id=$1 AND sourceroutingunit IS NOT NULL AND mappedroutingunit_id IS NULL
        GROUP BY sourceroutingunit ORDER BY sourceroutingunit`, [batchId]
    )
    return result.rows.map(row => ({ sourceLabel: row.sourceLabel, rowCount: Number(row.rowCount) }))
  }

  async getResult(batchId: string): Promise<ImportResult> {
    const batch = await this.getBatch(batchId)
    const { issues: _issues, ...safe } = batch
    return { ...safe, unmappedRoutingLabels: await this.unmappedRoutingLabels(batchId) }
  }
}

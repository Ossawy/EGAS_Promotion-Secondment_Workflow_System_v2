import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { recordAuditEvent, recordSecurityEvent } from '../audit/security-events.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import { inspectAnnualWorkbook } from './workbook-inspector.ts'
import { normalizeRoutingLabel, validateHeaders } from './header-validation.ts'
import {
  applyDuplicatePersonnelValidation,
  buildEmployeeAnnualData,
  normalizeStagingRow,
  rowsFromStoredRaw,
  type NormalizedStagingRow,
  type RoutingIndex,
  type RoutingTarget,
  type ValidationMessage
} from './normalization.ts'

export interface ImportActor {
  userId: string
  username: string
}

export interface ImportBatchSummary {
  id: string
  snapshotYear: number
  sourceFilename: string
  sourceSha256: string | null
  detectedHeaders: string[]
  status: string
  rowCount: number
  validRows: number
  warningRows: number
  blockedRows: number
  createdAt: string
  activatedAt: string | null
}

export interface UnmappedRoutingLabel {
  sourceLabel: string
  rowCount: number
}

export interface ImportResult extends ImportBatchSummary {
  unmappedRoutingLabels: UnmappedRoutingLabel[]
  workbookRoutingLabels: string[]
}

type BatchRow = {
  id: string
  snapshotYear: number
  sourceFilename: string
  sourceSha256: string | null
  detectedHeaders: string[]
  status: string
  rowCount: number
  createdAt: string
  activatedAt: string | null
}

type StoredStagingRow = {
  id: string
  sourceRowNumber: number
  raw: Record<string, string | number | boolean | null>
  normalizedData: Record<string, unknown>
}

type ActivationBatchRow = {
  id: string
  snapshotYear: number
  status: string
  rowCount: number
  activatedAt: string | null
}

type ActivationStagingRow = {
  id: string
  sourceRowNumber: number
  personnelNumber: string
  employeeName: string
  routingUnitId: string
  validationStatus: string
  normalizedData: Record<string, unknown>
}

async function resolveOperator(db: Queryable, usernameValue: unknown): Promise<ImportActor> {
  if (typeof usernameValue !== 'string' || usernameValue.trim().length < 1 || usernameValue.trim().length > 120) {
    throw new AppError(400, 'operator must be an application username')
  }
  const result = await db.query<ImportActor>(
    `SELECT id AS "userId", username
       FROM user_account
      WHERE username = $1 AND is_active = TRUE AND account_type = 'ADMIN'
      LIMIT 1`,
    [usernameValue.trim()]
  )
  if (!result.rows[0]) {
    throw new AppError(403, 'An active ADMIN operator account is required', 'IMPORT_OPERATOR_REJECTED')
  }
  return result.rows[0]
}

async function loadRoutingIndex(db: Queryable): Promise<RoutingIndex> {
  const units = await db.query<RoutingTarget>(
    `SELECT id, name_ar AS "nameAr" FROM routing_unit WHERE is_active = TRUE`
  )
  const aliases = await db.query<{ sourceLabel: string, id: string, nameAr: string }>(
    `SELECT a.source_label AS "sourceLabel", u.id, u.name_ar AS "nameAr"
       FROM routing_unit_source_alias a
       JOIN routing_unit u ON u.id = a.routing_unit_id
      WHERE a.is_active = TRUE AND u.is_active = TRUE`
  )

  const distinctTargetsByNormalizedLabel = new Map<string, Map<string, RoutingTarget>>()

  for (const unit of units.rows) {
    const key = normalizeRoutingLabel(unit.nameAr)
    if (!key) continue
    if (!distinctTargetsByNormalizedLabel.has(key)) {
      distinctTargetsByNormalizedLabel.set(key, new Map())
    }
    distinctTargetsByNormalizedLabel.get(key)!.set(unit.id, { id: unit.id, nameAr: unit.nameAr })
  }

  for (const alias of aliases.rows) {
    const key = normalizeRoutingLabel(alias.sourceLabel)
    if (!key) continue
    if (!distinctTargetsByNormalizedLabel.has(key)) {
      distinctTargetsByNormalizedLabel.set(key, new Map())
    }
    distinctTargetsByNormalizedLabel.get(key)!.set(alias.id, { id: alias.id, nameAr: alias.nameAr })
  }

  const targetsByNormalizedLabel = new Map<string, RoutingTarget[]>()
  for (const [key, targetMap] of distinctTargetsByNormalizedLabel.entries()) {
    targetsByNormalizedLabel.set(key, [...targetMap.values()])
  }

  return { targetsByNormalizedLabel }
}

async function insertStagingRow(db: Queryable, batchId: string, row: NormalizedStagingRow): Promise<void> {
  const annualData = buildEmployeeAnnualData(row)
  await db.query(
    `INSERT INTO employee_import_staging_row
      (id, import_batch_id, source_row_number, raw_data, normalized_data, routing_unit_id, validation_status, validation_messages)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      batchId,
      row.sourceRowNumber,
      JSON.stringify(row.raw),
      JSON.stringify(annualData),
      row.mappedRoutingUnitId,
      row.validationStatus,
      JSON.stringify(row.validationMessages)
    ]
  )
}

async function employeeId(db: Queryable, personnelNumber: string): Promise<string> {
  const insertResult = await db.query<{ id: string }>(
    `INSERT INTO employee (id, personnel_number, created_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (personnel_number) DO NOTHING
     RETURNING id`,
    [randomUUID(), personnelNumber]
  )
  if (insertResult.rows[0]?.id) return insertResult.rows[0].id

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM employee WHERE personnel_number = $1`,
    [personnelNumber]
  )
  if (existing.rows[0]?.id) return existing.rows[0].id

  throw new AppError(500, `Failed to resolve employee identity for personnel number ${personnelNumber}`)
}

async function insertAnnualSnapshot(
  db: Queryable,
  batchId: string,
  snapshotYear: number,
  row: ActivationStagingRow
): Promise<void> {
  const stableEmployeeId = await employeeId(db, row.personnelNumber)
  await db.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      stableEmployeeId,
      batchId,
      snapshotYear,
      row.personnelNumber,
      row.routingUnitId,
      JSON.stringify(row.normalizedData)
    ]
  )
}

async function activateValidatedBatch(
  db: Queryable,
  batchId: string,
  actor: ImportActor,
  evidence: RequestEvidence
): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('egas.annual-import.activation'))`)

  const batchResult = await db.query<ActivationBatchRow>(
    `SELECT id, snapshot_year AS "snapshotYear", status, row_count AS "rowCount", activated_at AS "activatedAt"
       FROM import_batch WHERE id = $1 FOR UPDATE`,
    [batchId]
  )
  const batch = batchResult.rows[0]
  if (!batch) throw new AppError(404, 'Import batch not found', 'IMPORT_BATCH_NOT_FOUND')
  if (batch.status === 'ACTIVATED' || batch.activatedAt !== null) {
    throw new AppError(409, 'Import batch is already activated', 'IMPORT_ALREADY_ACTIVATED')
  }
  if (batch.status !== 'VALIDATED') {
    throw new AppError(409, 'Import batch has not completed approved validation', 'IMPORT_NOT_VALIDATED')
  }
  const totalRows = Number(batch.rowCount)
  if (totalRows < 1) {
    throw new AppError(409, 'Import batch contains no data rows', 'IMPORT_EMPTY')
  }

  const snapshotYear = Number(batch.snapshotYear)

  // Ensure no other batch is activated for this year
  const activeExisting = await db.query(
    `SELECT 1 FROM import_batch WHERE snapshot_year = $1 AND status = 'ACTIVATED' AND id <> $2 LIMIT 1`,
    [snapshotYear, batchId]
  )
  if (activeExisting.rows[0]) {
    throw new AppError(409, 'An annual snapshot is already activated for this year', 'IMPORT_YEAR_ACTIVE')
  }

  // Ensure no snapshots exist for this year
  const existingSnapshots = await db.query(
    `SELECT 1 FROM employee_annual_snapshot WHERE snapshot_year = $1 LIMIT 1`,
    [snapshotYear]
  )
  if (existingSnapshots.rows[0]) {
    throw new AppError(409, 'Annual snapshots for this year already exist', 'IMPORT_YEAR_IMMUTABLE')
  }

  // Load all staging rows and verify fail-closed activation rules
  const rowsResult = await db.query<ActivationStagingRow>(
    `SELECT id, source_row_number AS "sourceRowNumber",
            normalized_data->>'personnelNumber' AS "personnelNumber",
            normalized_data->>'employeeName' AS "employeeName",
            routing_unit_id AS "routingUnitId",
            validation_status AS "validationStatus",
            normalized_data AS "normalizedData"
       FROM employee_import_staging_row
      WHERE import_batch_id = $1
      ORDER BY source_row_number`,
    [batchId]
  )

  if (rowsResult.rows.length !== totalRows) {
    throw new AppError(409, 'Staging row count does not match batch total', 'IMPORT_STAGING_INCONSISTENT')
  }

  // Fail closed: every row MUST have validation_status IN ('VALID', 'WARNING')
  const ineligibleRows = rowsResult.rows.filter(
    r => (r.validationStatus !== 'VALID' && r.validationStatus !== 'WARNING')
      || !r.routingUnitId
      || !r.personnelNumber
      || !r.employeeName
  )
  if (ineligibleRows.length > 0) {
    throw new AppError(
      409,
      `A full annual snapshot requires every row to be VALID or WARNING with resolved routing (${ineligibleRows.length} ineligible rows detected)`,
      'IMPORT_STAGING_INCONSISTENT'
    )
  }

  // Insert annual snapshots
  for (const row of rowsResult.rows) {
    await insertAnnualSnapshot(db, batchId, snapshotYear, row)
  }

  // Mark batch activated
  const updateResult = await db.query(
    `UPDATE import_batch SET status = 'ACTIVATED', activated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'VALIDATED'`,
    [batchId]
  )
  if (updateResult.rowCount !== 1) {
    throw new AppError(409, 'Import batch activation raced with another operation', 'IMPORT_ACTIVATION_RACE')
  }

  await recordAuditEvent(db, {
    actorUserId: actor.userId,
    eventType: 'IMPORT_BATCH_ACTIVATED',
    subjectType: 'import_batch',
    subjectId: batchId,
    details: { snapshotYear, totalRows }
  })
  await recordSecurityEvent(db, {
    actorUserId: actor.userId,
    eventType: 'IMPORT_BATCH_ACTIVATED',
    ...evidence,
    details: { batchId, snapshotYear, totalRows }
  })
}

export class ImportService {
  constructor(private readonly pool: Pool) {}

  async operator(username: unknown): Promise<ImportActor> {
    return await resolveOperator(this.pool, username)
  }

  async stageWorkbook(
    file: string,
    year: number,
    operatorUsername: unknown,
    evidence: RequestEvidence
  ): Promise<ImportResult> {
    const actor = await resolveOperator(this.pool, operatorUsername)
    let inspection
    try {
      inspection = await inspectAnnualWorkbook(file, year)
    } catch (error) {
      await withTransaction(this.pool, async db => {
        await recordSecurityEvent(db, {
          actorUserId: actor.userId,
          eventType: 'IMPORT_BATCH_VALIDATION_FAILED',
          ...evidence,
          details: {
            snapshotYear: year,
            sourceFilename: path.basename(file).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500),
            reasonCode: error instanceof AppError ? error.code : 'WORKBOOK_REJECTED'
          }
        })
      })
      throw error
    }

    const batchId = await withTransaction(this.pool, async db => {
      const id = randomUUID()
      await db.query(
        `INSERT INTO import_batch
          (id, snapshot_year, source_filename, source_sha256, detected_headers, status, row_count, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'STAGED', 0, CURRENT_TIMESTAMP)`,
        [
          id,
          year,
          inspection.basename,
          inspection.sourceSha256,
          JSON.stringify(inspection.headers.normalizedHeaders)
        ]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_STAGED',
        subjectType: 'import_batch',
        subjectId: id,
        details: {
          snapshotYear: year,
          sourceSha256: inspection.sourceSha256,
          totalRows: inspection.rowCount,
          workbookRoutingLabels: inspection.workbookRoutingLabels
        }
      })
      await recordSecurityEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_STAGED',
        ...evidence,
        details: {
          batchId: id,
          snapshotYear: year,
          sourceSha256: inspection.sourceSha256,
          totalRows: inspection.rowCount,
          workbookRoutingLabelsCount: inspection.workbookRoutingLabels.length
        }
      })

      const routing = await loadRoutingIndex(db)
      const normalized = inspection.rows.map(row => normalizeStagingRow(row, year, routing))
      applyDuplicatePersonnelValidation(normalized)

      for (const row of normalized) {
        await insertStagingRow(db, id, row)
      }

      await db.query(
        `UPDATE import_batch SET status = 'VALIDATED', row_count = $2 WHERE id = $1 AND status = 'STAGED'`,
        [id, normalized.length]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_VALIDATION_COMPLETED',
        subjectType: 'import_batch',
        subjectId: id,
        details: {
          snapshotYear: year,
          totalRows: normalized.length,
          validRows: normalized.filter(r => r.validationStatus === 'VALID').length,
          warningRows: normalized.filter(r => r.validationStatus === 'WARNING').length,
          blockedRows: normalized.filter(r => r.validationStatus === 'BLOCKED').length
        }
      })
      await recordSecurityEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_VALIDATION_COMPLETED',
        ...evidence,
        details: {
          batchId: id,
          snapshotYear: year,
          totalRows: normalized.length
        }
      })

      return id
    })

    const result = await this.getResult(batchId)
    return { ...result, workbookRoutingLabels: inspection.workbookRoutingLabels }
  }

  async revalidate(
    batchValue: unknown,
    actor: ImportActor,
    evidence: RequestEvidence
  ): Promise<ImportResult> {
    const batchId = uuid(batchValue, 'batchId')
    await withTransaction(this.pool, async db => {
      const batchResult = await db.query<{ snapshotYear: number, status: string, detectedHeaders: string[] }>(
        `SELECT snapshot_year AS "snapshotYear", status, detected_headers AS "detectedHeaders"
           FROM import_batch WHERE id = $1 FOR UPDATE`,
        [batchId]
      )
      const current = batchResult.rows[0]
      if (!current) throw new AppError(404, 'Import batch not found')
      if (current.status === 'ACTIVATED') {
        throw new AppError(409, 'Activated import batches cannot be revalidated')
      }

      const stored = await db.query<StoredStagingRow>(
        `SELECT id, source_row_number AS "sourceRowNumber", raw_data AS raw, normalized_data AS "normalizedData"
           FROM employee_import_staging_row WHERE import_batch_id = $1 ORDER BY source_row_number`,
        [batchId]
      )

      const routing = await loadRoutingIndex(db)
      const snapshotYear = Number(current.snapshotYear)

      // Re-extract detected reference dates from batch detected headers
      const headerVal = validateHeaders(Array.isArray(current.detectedHeaders) ? current.detectedHeaders : [], snapshotYear)
      const rows = rowsFromStoredRaw(stored.rows.map(r => ({
        sourceRowNumber: r.sourceRowNumber,
        raw: r.raw,
        experienceReferenceDate: (r.normalizedData?.experienceReferenceDate as string) ?? headerVal.experienceReferenceDate,
        currentJobTenureReferenceDate: (r.normalizedData?.currentJobTenureReferenceDate as string) ?? headerVal.currentJobTenureReferenceDate
      })))

      const normalized = rows.map(row => normalizeStagingRow(row, snapshotYear, routing))
      applyDuplicatePersonnelValidation(normalized)

      for (let index = 0; index < normalized.length; index += 1) {
        const row = normalized[index]!
        const annualData = buildEmployeeAnnualData(row)
        await db.query(
          `UPDATE employee_import_staging_row
              SET normalized_data = $2::jsonb,
                  routing_unit_id = $3,
                  validation_status = $4,
                  validation_messages = $5::jsonb
            WHERE id = $1`,
          [
            stored.rows[index]!.id,
            JSON.stringify(annualData),
            row.mappedRoutingUnitId,
            row.validationStatus,
            JSON.stringify(row.validationMessages)
          ]
        )
      }

      await db.query(
        `UPDATE import_batch SET row_count = $2, status = 'VALIDATED' WHERE id = $1`,
        [batchId, normalized.length]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_REVALIDATED',
        subjectType: 'import_batch',
        subjectId: batchId,
        details: {
          snapshotYear,
          totalRows: normalized.length,
          validRows: normalized.filter(r => r.validationStatus === 'VALID').length,
          warningRows: normalized.filter(r => r.validationStatus === 'WARNING').length,
          blockedRows: normalized.filter(r => r.validationStatus === 'BLOCKED').length
        }
      })
      await recordSecurityEvent(db, {
        actorUserId: actor.userId,
        eventType: 'IMPORT_BATCH_REVALIDATED',
        ...evidence,
        details: { batchId, snapshotYear, totalRows: normalized.length }
      })
    })

    return await this.getResult(batchId)
  }

  async activate(
    batchValue: unknown,
    actor: ImportActor,
    evidence: RequestEvidence
  ): Promise<ImportResult> {
    const batchId = uuid(batchValue, 'batchId')
    try {
      await withTransaction(this.pool, async db => {
        await activateValidatedBatch(db, batchId, actor, evidence)
      })
    } catch (error) {
      try {
        await withTransaction(this.pool, async db => {
          await recordSecurityEvent(db, {
            actorUserId: actor.userId,
            eventType: 'IMPORT_BATCH_ACTIVATION_REJECTED',
            ...evidence,
            details: {
              batchId,
              reasonCode: error instanceof AppError ? error.code : 'IMPORT_ACTIVATION_FAILED'
            }
          })
        })
      } catch {
        // Audit failure must not replace original error
      }
      throw error
    }
    return await this.getResult(batchId)
  }

  async getBatch(batchValue: unknown): Promise<ImportBatchSummary & { issues: Array<{ code: string, rowCount: number }> }> {
    const batchId = uuid(batchValue, 'batchId')
    const result = await this.pool.query<BatchRow>(
      `SELECT id, snapshot_year AS "snapshotYear", source_filename AS "sourceFilename",
              source_sha256 AS "sourceSha256", detected_headers AS "detectedHeaders",
              status, row_count AS "rowCount", created_at AS "createdAt", activated_at AS "activatedAt"
         FROM import_batch WHERE id = $1`,
      [batchId]
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'Import batch not found')

    const statusCounts = await this.pool.query<{ validation_status: string, count: number }>(
      `SELECT validation_status, COUNT(*)::integer AS count
         FROM employee_import_staging_row
        WHERE import_batch_id = $1
        GROUP BY validation_status`,
      [batchId]
    )

    let validRows = 0
    let warningRows = 0
    let blockedRows = 0
    for (const sc of statusCounts.rows) {
      if (sc.validation_status === 'VALID') validRows = Number(sc.count)
      if (sc.validation_status === 'WARNING') warningRows = Number(sc.count)
      if (sc.validation_status === 'BLOCKED') blockedRows = Number(sc.count)
    }

    const messages = await this.pool.query<{ messages: ValidationMessage[] }>(
      `SELECT validation_messages AS messages FROM employee_import_staging_row WHERE import_batch_id = $1`,
      [batchId]
    )
    const issueCounts = new Map<string, number>()
    for (const msgRow of messages.rows) {
      if (Array.isArray(msgRow.messages)) {
        for (const message of msgRow.messages) {
          issueCounts.set(message.code, (issueCounts.get(message.code) ?? 0) + 1)
        }
      }
    }

    return {
      id: row.id,
      snapshotYear: Number(row.snapshotYear),
      sourceFilename: row.sourceFilename,
      sourceSha256: row.sourceSha256,
      detectedHeaders: Array.isArray(row.detectedHeaders) ? row.detectedHeaders : [],
      status: row.status,
      rowCount: Number(row.rowCount),
      validRows,
      warningRows,
      blockedRows,
      createdAt: new Date(row.createdAt).toISOString(),
      activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
      issues: [...issueCounts]
        .map(([code, count]) => ({ code, rowCount: count }))
        .sort((a, b) => a.code.localeCompare(b.code))
    }
  }

  async listBatches(skip: number, top: number, year?: number, status?: string): Promise<ImportBatchSummary[]> {
    const result = await this.pool.query<BatchRow>(
      `SELECT id, snapshot_year AS "snapshotYear", source_filename AS "sourceFilename",
              source_sha256 AS "sourceSha256", detected_headers AS "detectedHeaders",
              status, row_count AS "rowCount", created_at AS "createdAt", activated_at AS "activatedAt"
         FROM import_batch
        WHERE ($1::integer IS NULL OR snapshot_year = $1)
          AND ($2::varchar IS NULL OR status = $2)
        ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
      [year ?? null, status ?? null, top, skip]
    )

    const summaries: ImportBatchSummary[] = []
    for (const row of result.rows) {
      const statusCounts = await this.pool.query<{ validation_status: string, count: number }>(
        `SELECT validation_status, COUNT(*)::integer AS count
           FROM employee_import_staging_row
          WHERE import_batch_id = $1
          GROUP BY validation_status`,
        [row.id]
      )
      let validRows = 0
      let warningRows = 0
      let blockedRows = 0
      for (const sc of statusCounts.rows) {
        if (sc.validation_status === 'VALID') validRows = Number(sc.count)
        if (sc.validation_status === 'WARNING') warningRows = Number(sc.count)
        if (sc.validation_status === 'BLOCKED') blockedRows = Number(sc.count)
      }
      summaries.push({
        id: row.id,
        snapshotYear: Number(row.snapshotYear),
        sourceFilename: row.sourceFilename,
        sourceSha256: row.sourceSha256,
        detectedHeaders: Array.isArray(row.detectedHeaders) ? row.detectedHeaders : [],
        status: row.status,
        rowCount: Number(row.rowCount),
        validRows,
        warningRows,
        blockedRows,
        createdAt: new Date(row.createdAt).toISOString(),
        activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null
      })
    }
    return summaries
  }

  async listRows(
    batchValue: unknown,
    skip: number,
    top: number,
    status?: string
  ): Promise<Array<Record<string, unknown>>> {
    const batchId = uuid(batchValue, 'batchId')
    await this.getBatch(batchId)
    const result = await this.pool.query<{
      sourceRowNumber: number
      normalizedData: Record<string, unknown>
      routingUnitId: string | null
      mappedRoutingUnitName: string | null
      validationStatus: string
      validationMessages: ValidationMessage[]
    }>(
      `SELECT s.source_row_number AS "sourceRowNumber",
              s.normalized_data AS "normalizedData",
              s.routing_unit_id AS "routingUnitId",
              u.name_ar AS "mappedRoutingUnitName",
              s.validation_status AS "validationStatus",
              s.validation_messages AS "validationMessages"
         FROM employee_import_staging_row s
         LEFT JOIN routing_unit u ON u.id = s.routing_unit_id
        WHERE s.import_batch_id = $1 AND ($2::varchar IS NULL OR s.validation_status = $2)
        ORDER BY s.source_row_number LIMIT $3 OFFSET $4`,
      [batchId, status ?? null, top, skip]
    )
    return result.rows.map(r => ({
      sourceRowNumber: r.sourceRowNumber,
      ...r.normalizedData,
      routingUnitId: r.routingUnitId,
      mappedRoutingUnitName: r.mappedRoutingUnitName,
      validationStatus: r.validationStatus,
      validationMessages: r.validationMessages
    }))
  }

  async unmappedRoutingLabels(batchValue: unknown): Promise<UnmappedRoutingLabel[]> {
    const batchId = uuid(batchValue, 'batchId')
    await this.getBatch(batchId)
    const result = await this.pool.query<{ sourceLabel: string, rowCount: number }>(
      `SELECT normalized_data->>'sourceRoutingLabel' AS "sourceLabel", COUNT(*)::integer AS "rowCount"
         FROM employee_import_staging_row
        WHERE import_batch_id = $1 AND routing_unit_id IS NULL
        GROUP BY normalized_data->>'sourceRoutingLabel'
        ORDER BY "sourceLabel"`,
      [batchId]
    )
    return result.rows
      .filter(r => Boolean(r.sourceLabel))
      .map(row => ({ sourceLabel: row.sourceLabel, rowCount: Number(row.rowCount) }))
  }

  async getResult(batchId: string): Promise<ImportResult> {
    const batch = await this.getBatch(batchId)
    const { issues: _issues, ...safe } = batch
    return {
      ...safe,
      unmappedRoutingLabels: await this.unmappedRoutingLabels(batchId),
      workbookRoutingLabels: []
    }
  }
}

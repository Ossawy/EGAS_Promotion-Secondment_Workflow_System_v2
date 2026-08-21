import { createHash, randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'

export interface StageSnapshotData {
  requestId: string
  requestNumber: string
  requestType: string
  routingUnitId: string | null
  iterationId: string
  iterationNo: number
  stageExecutionId: string
  stageCode: string
  executionNo: number
  responsibleUnitId: string
  formSections: Array<{
    id: string
    category: string
    displayOrder: number
    data: Record<string, unknown>
  }>
  candidates: Array<{
    id: string
    employeeSnapshotId: string
    personnelNumber: string
    frozenData: Record<string, unknown>
    acceptedData: Record<string, unknown>
  }>
  submittedAt: string
  submittedByUserId: string
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']'
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify((obj as Record<string, unknown>)[key])}`)
  return '{' + entries.join(',') + '}'
}

export async function createStageSubmissionSnapshot(
  db: Queryable,
  stageExecutionId: string,
  data: StageSnapshotData
): Promise<{ id: string, sha256: string }> {
  // Check if snapshot already exists
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM stage_submission_snapshot WHERE stage_execution_id = $1`,
    [stageExecutionId]
  )
  if (existing.rows[0]) {
    throw new AppError(409, 'Stage submission snapshot already exists and is immutable', 'STAGE_SNAPSHOT_IMMUTABLE')
  }

  const serialized = stableStringify(data)
  const sha256 = createHash('sha256').update(serialized).digest('hex')
  const id = randomUUID()

  await db.query(
    `INSERT INTO stage_submission_snapshot
      (id, stage_execution_id, payload, sha256, created_at)
     VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP)`,
    [id, stageExecutionId, JSON.stringify(data), sha256]
  )

  return { id, sha256 }
}

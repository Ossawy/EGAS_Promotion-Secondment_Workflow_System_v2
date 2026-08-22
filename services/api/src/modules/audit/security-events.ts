import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'

export type SecurityEventInput = Partial<RequestEvidence> & {
  actorUserId?: string | null
  eventType: string
  routingUnitId?: string | null
  details?: Record<string, unknown>
}

export type AuditEventInput = {
  actorUserId?: string | null
  eventType: string
  subjectType?: string | null
  subjectId?: string | null
  details?: Record<string, unknown>
  actorSnapshot?: Record<string, unknown>
  subjectSnapshot?: Record<string, unknown>
}

async function actorSnapshot(db: Queryable, actorUserId: string | null): Promise<Record<string, unknown>> {
  if (!actorUserId) return {}
  const result = await db.query<Record<string, unknown>>(
    `SELECT a.username,
            a.display_name AS "displayName",
            a.job_title AS "jobTitle",
            a.account_type AS "accountType",
            a.is_active AS "isActive",
            ou.id AS "operationalUnitId",
            ou.kind AS "operationalUnitKind",
            ou.name AS "operationalUnitName",
            uma.id AS "managerAssignmentId"
       FROM user_account a
       LEFT JOIN user_unit_membership uum
         ON uum.user_id=a.id AND uum.effective_to IS NULL
       LEFT JOIN operational_unit ou ON ou.id=uum.unit_id
       LEFT JOIN unit_manager_assignment uma
         ON uma.unit_id=uum.unit_id
        AND uma.manager_user_id=a.id
        AND uma.effective_to IS NULL
      WHERE a.id=$1`,
    [actorUserId]
  )
  return result.rows[0] ?? {}
}

async function subjectSnapshot(
  db: Queryable,
  subjectType: string | null,
  subjectId: string | null
): Promise<Record<string, unknown>> {
  if (!subjectType || !subjectId) return {}
  if (subjectType === 'user_account') {
    const result = await db.query<Record<string, unknown>>(
      `SELECT username,display_name AS "displayName",job_title AS "jobTitle",
              account_type AS "accountType",is_active AS "isActive"
         FROM user_account WHERE id=$1`,
      [subjectId]
    )
    return result.rows[0] ?? {}
  }
  if (subjectType === 'operational_unit') {
    const result = await db.query<Record<string, unknown>>(
      `SELECT ou.kind,ou.name,ou.is_active AS "isActive",
              ru.code AS "routingUnitCode",ru.name_ar AS "routingUnitName"
         FROM operational_unit ou
         LEFT JOIN routing_unit ru ON ru.id=ou.routing_unit_id
        WHERE ou.id=$1`,
      [subjectId]
    )
    return result.rows[0] ?? {}
  }
  if (subjectType === 'workflow_request') {
    const result = await db.query<Record<string, unknown>>(
      `SELECT wr.request_number AS "requestNumber",wr.request_type AS "requestType",
              wr.status,ru.code AS "routingUnitCode",ru.name_ar AS "routingUnitName"
         FROM workflow_request wr
         LEFT JOIN routing_unit ru ON ru.id=wr.routing_unit_id
        WHERE wr.id=$1`,
      [subjectId]
    )
    return result.rows[0] ?? {}
  }
  if (subjectType === 'unit_manager_assignment') {
    const result = await db.query<Record<string, unknown>>(
      `SELECT ou.name AS "unitName",ou.kind,
              a.username AS "managerUsername",a.display_name AS "managerDisplayName",
              concat(ou.name,' — ',a.display_name) AS label
         FROM unit_manager_assignment uma
         JOIN operational_unit ou ON ou.id=uma.unit_id
         JOIN user_account a ON a.id=uma.manager_user_id
        WHERE uma.id=$1`,
      [subjectId]
    )
    return result.rows[0] ?? {}
  }
  if (subjectType === 'user_unit_membership') {
    const result = await db.query<Record<string, unknown>>(
      `SELECT a.username,a.display_name AS "displayName",ou.name AS "unitName",ou.kind,
              concat(a.display_name,' — ',ou.name) AS label
         FROM user_unit_membership uum
         JOIN user_account a ON a.id=uum.user_id
         JOIN operational_unit ou ON ou.id=uum.unit_id
        WHERE uum.id=$1`,
      [subjectId]
    )
    return result.rows[0] ?? {}
  }
  if (subjectType === 'import_batch') {
    const result=await db.query<Record<string,unknown>>(
      `SELECT snapshot_year AS "snapshotYear",source_filename AS "sourceFilename",
              concat('بيانات العاملين لسنة ',snapshot_year) AS label
         FROM import_batch WHERE id=$1`,[subjectId]
    )
    return result.rows[0]??{}
  }
  if(subjectType==='routing_unit_source_alias'){
    const result=await db.query<Record<string,unknown>>(
      `SELECT a.source_label AS "sourceLabel",r.code AS "routingUnitCode",r.name_ar AS "routingUnitName",
              concat(a.source_label,' — ',r.name_ar) AS label
         FROM routing_unit_source_alias a JOIN routing_unit r ON r.id=a.routing_unit_id
        WHERE a.id=$1`,[subjectId]
    )
    return result.rows[0]??{}
  }
  if(subjectType==='user_signature_asset'){
    const result=await db.query<Record<string,unknown>>(
      `SELECT a.username,a.display_name AS "displayName",concat('توقيع ',a.display_name) AS label
         FROM user_signature_asset s JOIN user_account a ON a.id=s.user_id WHERE s.id=$1`,[subjectId]
    )
    return result.rows[0]??{}
  }
  if(subjectType==='stage_execution'){
    const result=await db.query<Record<string,unknown>>(
      `SELECT wr.request_number AS "requestNumber",se.stage_code AS "stageCode",se.execution_no AS "executionNo",
              concat(wr.request_number,' — ',se.stage_code) AS label
         FROM stage_execution se JOIN workflow_iteration wi ON wi.id=se.iteration_id
         JOIN workflow_request wr ON wr.id=wi.request_id WHERE se.id=$1`,[subjectId]
    )
    return result.rows[0]??{}
  }
  if(subjectType==='work_assignment'){
    const result=await db.query<Record<string,unknown>>(
      `SELECT wr.request_number AS "requestNumber",se.stage_code AS "stageCode",
              a.username AS "assigneeUsername",a.display_name AS "assigneeDisplayName",
              concat(wr.request_number,' — ',a.display_name) AS label
         FROM work_assignment wa JOIN user_account a ON a.id=wa.assigned_to_user_id
         JOIN stage_execution se ON se.id=wa.stage_execution_id
         JOIN workflow_iteration wi ON wi.id=se.iteration_id
         JOIN workflow_request wr ON wr.id=wi.request_id WHERE wa.id=$1`,[subjectId]
    )
    return result.rows[0]??{}
  }
  return {}
}

export async function recordSecurityEvent(db: Queryable, input: SecurityEventInput): Promise<void> {
  const details = {
    ...(input.details ?? {}),
    ...(input.routingUnitId !== undefined && input.routingUnitId !== null ? { routingUnitId: input.routingUnitId } : {}),
    ...(input.correlationId !== undefined && input.correlationId !== null ? { correlationId: input.correlationId } : {})
  }

  await db.query(
    `INSERT INTO security_event
      (id, actor_user_id, event_type, ip_address, user_agent, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.eventType,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(details)
    ]
  )
}

export async function recordAuditEvent(db: Queryable, input: AuditEventInput): Promise<void> {
  const actorUserId = input.actorUserId ?? null
  const subjectType = input.subjectType ?? null
  const subjectId = input.subjectId ?? null
  const [frozenActor, frozenSubject] = await Promise.all([
    input.actorSnapshot ? Promise.resolve(input.actorSnapshot) : actorSnapshot(db, actorUserId),
    input.subjectSnapshot ? Promise.resolve(input.subjectSnapshot) : subjectSnapshot(db, subjectType, subjectId)
  ])
  await db.query(
    `INSERT INTO audit_event
      (id, actor_user_id, event_type, subject_type, subject_id, details,
       actor_snapshot, subject_snapshot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, CURRENT_TIMESTAMP)`,
    [
      randomUUID(),
      actorUserId,
      input.eventType,
      subjectType,
      subjectId,
      JSON.stringify(input.details ?? {}),
      JSON.stringify(frozenActor),
      JSON.stringify(frozenSubject)
    ]
  )
}

import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'

export async function resolveAuthorityRecipient(db: Queryable, assignmentId: string): Promise<string> {
  const assignment = await db.query<{ userId: string }>(
    `SELECT a.useraccount_id AS "userId" FROM egas_approvingauthorityassignment a
     JOIN egas_useraccount u ON u.id=a.useraccount_id AND u.isactive=TRUE
     JOIN egas_useraccountrole r ON r.user_id=u.id AND r.role='APPROVING_AUTHORITY' AND r.isactive=TRUE
     WHERE a.id=$1 AND a.isactive=TRUE AND a.validfrom<=CURRENT_DATE AND (a.validto IS NULL OR a.validto>=CURRENT_DATE)`, [assignmentId])
  const primary = assignment.rows[0]?.userId
  if (!primary) throw new AppError(409, 'Selected authority assignment is no longer effective', 'WORKFLOW_AUTHORITY_NOT_FOUND')
  const delegates = await db.query<{ userId: string }>(
    `SELECT DISTINCT d.delegateduser_id AS "userId" FROM egas_authoritydelegation d
     JOIN egas_useraccount u ON u.id=d.delegateduser_id AND u.isactive=TRUE
     JOIN egas_useraccountrole r ON r.user_id=u.id AND r.role='APPROVING_AUTHORITY' AND r.isactive=TRUE
     WHERE d.authorityassignment_id=$1 AND d.isactive=TRUE AND d.validfrom<=CURRENT_TIMESTAMP
       AND (d.validto IS NULL OR d.validto>=CURRENT_TIMESTAMP)`, [assignmentId])
  if (delegates.rows.length > 1) {
    throw new AppError(409, 'More than one effective delegation requires stakeholder resolution', 'WORKFLOW_AUTHORITY_DELEGATION_AMBIGUOUS')
  }
  return delegates.rows[0]?.userId ?? primary
}

import type { Queryable } from '../types.js'

export async function findActivePrivilegedAdminAccounts(db: Queryable): Promise<Array<{ id: string }>> {
  const result = await db.query<{ id: string }>(
    `SELECT DISTINCT account.id
       FROM egas_useraccount AS account
       JOIN egas_useraccountrole AS role_assignment ON role_assignment.user_id = account.id
      WHERE account.isactive = TRUE
        AND role_assignment.isactive = TRUE
        AND role_assignment.role = 'ADMIN'
        AND role_assignment.canmanageadmins = TRUE`
  )
  return result.rows
}

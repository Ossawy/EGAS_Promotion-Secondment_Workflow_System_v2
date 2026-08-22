import type { Queryable } from '../types.js'

export async function findActiveAdminAccounts(db: Queryable): Promise<Array<{ id: string }>> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM user_account
      WHERE is_active=TRUE AND account_type='ADMIN'`
  )
  return result.rows
}

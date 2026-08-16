import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { bootstrapAdmin } from '../src/modules/admin/bootstrap-cli.js'
import { isolatedPool } from './helpers/database.js'

let pool: Pool
beforeEach(async () => { pool = await isolatedPool() })
afterEach(async () => { await pool.end() })

describe('first Admin bootstrap', () => {
  it('creates account and role atomically, then safely refuses a second bootstrap', async () => {
    const input = {
      username: 'bootstrap-synthetic', displayName: 'Bootstrap Synthetic',
      temporaryPassword: 'synthetic-bootstrap-password', staffIdentifier: null, jobTitle: null
    }
    await bootstrapAdmin(input, pool)
    const privileged = await pool.query(
      `SELECT a.mustchangepassword,r.canmanageadmins
         FROM egas_useraccount a JOIN egas_useraccountrole r ON r.user_id=a.id
        WHERE a.username=$1 AND a.isactive=TRUE AND r.role='ADMIN' AND r.isactive=TRUE`, [input.username]
    )
    expect(privileged.rows).toEqual([{ mustchangepassword: true, canmanageadmins: true }])
    await expect(bootstrapAdmin({ ...input, username: 'bootstrap-second' }, pool))
      .rejects.toThrow('an active Manage-Admins account already exists')
    expect((await pool.query("SELECT id FROM egas_useraccount WHERE username='bootstrap-second'")).rows).toHaveLength(0)
  })
})

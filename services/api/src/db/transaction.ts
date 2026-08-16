import type { Pool } from 'pg'
import type { Queryable } from './types.ts'

export async function withTransaction<T>(pool: Pool, operation: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original failure; the pool will discard a broken client.
    }
    throw error
  } finally {
    client.release()
  }
}

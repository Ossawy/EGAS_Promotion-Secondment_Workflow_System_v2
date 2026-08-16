import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'

export interface NotificationInput {
  recipientUserId: string
  requestId?: string | null
  type: string
  titleAr: string
  bodyAr?: string | null
}

type NotificationRow = {
  id: string
  requestId: string | null
  type: string
  titleAr: string
  bodyAr: string | null
  createdAt: Date | string
  readAt: Date | string | null
}

function view(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.id,
    requestId: row.requestId,
    requestPath: row.requestId ? `/api/workflow/requests/${row.requestId}` : null,
    type: row.type,
    titleAr: row.titleAr,
    bodyAr: row.bodyAr,
    createdAt: new Date(row.createdAt).toISOString(),
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    isRead: row.readAt !== null
  }
}

function projection(): string {
  return `id,request_id AS "requestId",notificationtype AS type,titlear AS "titleAr",
    bodyar AS "bodyAr",createdat AS "createdAt",readat AS "readAt"`
}

export async function createNotification(db: Queryable, input: NotificationInput): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO egas_notification
      (id,recipientuser_id,request_id,notificationtype,titlear,bodyar,createdat)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
    [id, input.recipientUserId, input.requestId ?? null, input.type, input.titleAr, input.bodyAr ?? null]
  )
  return id
}

export class NotificationService {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, skip: number, top: number, unreadOnly: boolean): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${projection()} FROM egas_notification
        WHERE recipientuser_id=$1 AND ($2::boolean=FALSE OR readat IS NULL)
        ORDER BY createdat DESC,id DESC LIMIT $3 OFFSET $4`, [userId, unreadOnly, top, skip]
    )
    return result.rows.map(view)
  }

  async markRead(userId: string, notificationValue: unknown): Promise<Record<string, unknown>> {
    const notificationId = uuid(notificationValue, 'notificationId')
    return await withTransaction(this.pool, async db => {
      const changed = await db.query<NotificationRow>(
        `UPDATE egas_notification SET readat=COALESCE(readat,CURRENT_TIMESTAMP)
          WHERE id=$1 AND recipientuser_id=$2 RETURNING ${projection()}`,
        [notificationId, userId]
      )
      const row = changed.rows[0]
      if (!row) throw new AppError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND')
      return view(row)
    })
  }
}

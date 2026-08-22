import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { NotificationSummary } from '../api/workflow-types'
import { STAGE_LABELS } from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  STAGE_INBOX_ARRIVED: 'وصلت مرحلة جديدة إلى صندوق المدير',
  STAGE_ASSIGNED: 'تم إسناد عمل جديد إليك',
  STAGE_SUBMITTED_TO_MANAGER: 'رفع الموظف العمل للمراجعة',
  CORRECTION_REQUIRED: 'مطلوب تصحيح منك على مرحلة مسندة',
  STAGE_RETURNED: 'أُرجيت إليك مرحلة من مرحلة لاحقة',
  WORKFLOW_REJECTED: 'تم رفض طلب — بانتظار قرار الموارد البشرية'
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function NotificationsPage(): React.JSX.Element {
  const [notifications, setNotifications] = useState<NotificationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setNotifications(await workflowApi.notifications(100))
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function open(item: NotificationSummary): Promise<void> {
    try {
      if (!item.isRead) await workflowApi.markNotificationRead(item.id)
    } catch {}
    if (item.requestId) window.location.assign(`/requests/${item.requestId}`)
  }

  if (error) {
    return <EmptyState icon={Bell} title="تعذر تحميل الإشعارات" body={error} />
  }

  const unreadCount = (notifications ?? []).filter(entry => !entry.isRead).length

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>الإشعارات</h1>
        <span className="badge badge--info">{unreadCount} غير مقروء</span>
      </header>

      {notifications === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : notifications.length === 0 ? (
        <EmptyState icon={Bell} title="لا توجد إشعارات" body="ستظهر هنا إشعارات الإسناد والمراجعة والتصحيح." />
      ) : (
        <section className="card" aria-label="قائمة الإشعارات">
          <ul className="notification-full-list">
            {notifications.map(item => (
              <li key={item.id} className={item.isRead ? '' : 'is-unread'}>
                <button type="button" onClick={() => void open(item)}>
                  <strong>{NOTIFICATION_TYPE_LABELS[item.notificationType] ?? item.notificationType}</strong>
                  <small>
                    {item.requestNumber
                      ? <>طلب <span className="mono">{item.requestNumber}</span>{item.stageCode ? ` • ${STAGE_LABELS[item.stageCode]}` : ''}</>
                      : ''}
                    {' • '}
                    {formatDateTime(item.createdAt)}
                    {!item.isRead ? ' • غير مقروء' : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">اضغط على أي إشعار لفتح الطلب المرتبط به. <Link to="/notifications">تحديث القائمة</Link></p>
        </section>
      )}
    </div>
  )
}

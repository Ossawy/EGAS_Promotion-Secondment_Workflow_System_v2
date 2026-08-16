import { useEffect, useState } from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { apiJson, apiRequest } from '../api/client'
import type { NotificationItem } from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'

export function NotificationsPage(): React.JSX.Element {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiRequest<NotificationItem[]>('/api/notifications?top=100')
      .then(setItems)
      .finally(() => setLoading(false))
  }, [])

  async function read(item: NotificationItem): Promise<void> {
    if (item.isRead) return
    const updated = await apiJson<NotificationItem>(`/api/notifications/${item.id}/read`, 'POST', {})
    setItems(current => current.map(entry => entry.id === updated.id ? updated : entry))
  }

  return <div className="page-stack">
    <header className="page-heading"><div><p>بوابة الموارد البشرية</p><h1>الإشعارات</h1><span>تنبيهات الأعمال المتاحة ضمن حسابك</span></div></header>
    <section className="panel">
      {loading ? <div className="loading-panel" role="status"><span className="spinner" /> جارٍ تحميل الإشعارات...</div> : items.length === 0 ?
        <EmptyState icon={Bell} title="لا توجد إشعارات" body="ستظهر هنا التنبيهات عند توفر عمل جديد أو انتقال الطلب بين المراحل." /> :
        <div className="full-notification-list">{items.map(item => <article key={item.id} className={item.isRead ? '' : 'is-unread'}>
          <span aria-hidden="true"><Bell size={20} /></span>
          <div><h2>{item.titleAr}</h2>{item.bodyAr && <p>{item.bodyAr}</p>}<time>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</time></div>
          {!item.isRead && <button className="button button--secondary" onClick={() => void read(item)}><CheckCheck size={17} /> تعليم كمقروء</button>}
        </article>)}</div>}
    </section>
  </div>
}

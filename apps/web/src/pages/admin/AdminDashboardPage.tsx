import { useEffect, useState } from 'react'
import { AlertTriangle, Database, LockKeyhole, Route, ShieldCheck, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiRequest } from '../../api/client'
import type { AdminOverview } from '../../api/admin-types'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'

function date(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function AdminDashboardPage(): React.JSX.Element {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiRequest<AdminOverview>('/api/admin/overview').then(setOverview).catch(() => setError('تعذر تحميل مؤشرات الإدارة.'))
  }, [])

  if (!overview && !error) return <div className="loading-panel"><span className="spinner" /> جارٍ تحميل مؤشرات الإدارة...</div>
  if (!overview) return <p className="error" role="alert">{error}</p>
  const coverage = overview.authorityCoverage.total === 0 ? 0 : Math.round(overview.authorityCoverage.covered / overview.authorityCoverage.total * 100)

  return <div className="page-stack">
    <header className="page-heading"><div><p>إيجاس / إدارة النظام</p><h1>لوحة الإدارة</h1><span>مؤشرات تشغيلية وإدارية فقط؛ لا تعرض هذه اللوحة بيانات العاملين.</span></div></header>
    <div className={`state-banner ${overview.pilotReady ? 'state-banner--info' : 'state-banner--warning'}`}>
      {overview.pilotReady ? <ShieldCheck /> : <AlertTriangle />}
      <div><strong>{overview.pilotReady ? 'متطلبات البيانات الأساسية جاهزة' : 'الإعداد التجريبي غير مكتمل'}</strong><span>{overview.pilotReady ? 'توجد لقطة سنوية نشطة وتغطية سلطة اعتماد لكل وحدات المسار.' : 'لا يتم استنتاج أو تصنيع التغطية والبيانات؛ راجع اللقطة السنوية وتعيينات السلطة أدناه.'}</span></div>
    </div>
    <section className="metric-grid">
      <article className="metric-card"><div><p>إجمالي الحسابات</p><strong>{overview.accounts.total}</strong><small>{overview.accounts.active} نشط</small></div><span><Users /></span></article>
      <article className="metric-card metric-card--danger"><div><p>معطل / مقفل</p><strong>{overview.accounts.disabled + overview.accounts.locked}</strong><small>{overview.accounts.disabled} معطل · {overview.accounts.locked} مقفل</small></div><span><LockKeyhole /></span></article>
      <article className="metric-card metric-card--info"><div><p>تغطية سلطة الاعتماد</p><strong>{overview.authorityCoverage.covered}/{overview.authorityCoverage.total}</strong><small>{coverage}% من الوحدات النشطة</small></div><span><ShieldCheck /></span></article>
      <article className="metric-card metric-card--success"><div><p>بدائل المسار النشطة</p><strong>{overview.routingCoverage.activeAliases}</strong><small>مطابقات صريحة معتمدة</small></div><span><Route /></span></article>
    </section>
    <div className="admin-overview-grid">
      <section className="panel">
        <div className="panel__header"><div><h2>البيانات السنوية</h2><p>حالة اللقطة وآخر دفعة مستوردة بواسطة المشغل.</p></div><Link to="/admin/dataset">إدارة البيانات</Link></div>
        <div className="admin-readiness">
          <article><Database /><div><small>اللقطة النشطة</small><strong>{overview.activeSnapshot.available ? `${overview.activeSnapshot.snapshotYear} · ${overview.activeSnapshot.employeeCount} سجل` : 'لا توجد لقطة نشطة'}</strong></div></article>
          <article><Route /><div><small>آخر دفعة</small><strong>{overview.latestBatch ? `${overview.latestBatch.snapshotYear} · ${overview.latestBatch.status}` : 'لا توجد دفعات'}</strong>{overview.latestBatch && <span>{overview.latestBatch.validRows} صالح · {overview.latestBatch.warningRows} تحذير · {overview.latestBatch.blockedRows} محظور</span>}</div></article>
        </div>
      </section>
      <section className="panel">
        <div className="panel__header"><div><h2>النشاط الإداري الأخير</h2><p>أحدث أحداث الأمن والإدارة المسجلة.</p></div><Link to="/admin/audit">عرض التدقيق</Link></div>
        {overview.recentActivity.length === 0 ? <EmptyState icon={ShieldCheck} title="لا يوجد نشاط مسجل" body="ستظهر أحداث الإدارة والأمن هنا عند تنفيذ العمليات." /> : <div className="admin-activity-list">{overview.recentActivity.map(event => <article key={event.id}><span><ShieldCheck size={17} /></span><div><strong>{event.eventType}</strong><small>{event.actorName ?? 'النظام'} · {date(event.createdAt)}</small></div><StatusBadge status="COMPLETED" label="مسجل" /></article>)}</div>}
      </section>
    </div>
  </div>
}

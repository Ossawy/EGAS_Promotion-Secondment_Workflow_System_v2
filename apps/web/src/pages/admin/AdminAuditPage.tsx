import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FileDown, Filter, ShieldCheck } from 'lucide-react'
import { apiRequest } from '../../api/client'
import type { AuditEvent, RoutingUnit } from '../../api/admin-types'
import { EmptyState } from '../../components/EmptyState'

function date(value: string): string { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) }

export function AdminAuditPage(): React.JSX.Element {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [filters, setFilters] = useState({ eventType: '', actor: '', from: '', to: '' })
  const [applied, setApplied] = useState(filters)
  const [skip, setSkip] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [units, setUnits] = useState<RoutingUnit[]>([])
  const [report, setReport] = useState({ routingUnitId: '', periodCode: 'MONTHLY', periodStart: '', periodEnd: '' })
  const top = 50

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null)
    const query = new URLSearchParams({ skip: String(skip), top: String(top) })
    for (const [key, value] of Object.entries(applied)) if (value) query.set(key, value)
    try { setEvents(await apiRequest<AuditEvent[]>(`/api/admin/audit-events?${query}`)) }
    catch { setError('تعذر تحميل سجل التدقيق.') }
    finally { setLoading(false) }
  }, [applied, skip])

  useEffect(() => { void load() }, [load])
  useEffect(() => { apiRequest<RoutingUnit[]>('/api/reference/routing-units').then(setUnits).catch(() => undefined) }, [])

  const reportQuery = new URLSearchParams(report).toString()
  const reportReady = Boolean(report.routingUnitId && report.periodStart && report.periodEnd)

  return <div className="page-stack">
    <header className="page-heading"><div><p>إدارة النظام / التدقيق</p><h1>سجل الأمن والنشاط الإداري</h1><span>قراءة مقيدة ومقسمة إلى صفحات للأحداث المسجلة في الخادم.</span></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><div className="panel__header"><div><h2>سجل تدقيق سير العمل PDF</h2><p>تقرير منفصل لوحدة مسار وفترة محددة، بحد أقصى سنة و5,000 حدث.</p></div><FileDown size={21} /></div>
      <div className="admin-form audit-pdf-form">
        <label>وحدة المسار<select value={report.routingUnitId} onChange={event => setReport(value => ({ ...value, routingUnitId: event.target.value }))}><option value="">اختر الوحدة</option>{units.filter(unit => unit.isActive).map(unit => <option key={unit.id} value={unit.id}>{unit.nameAr}</option>)}</select></label>
        <label>نوع الفترة<select value={report.periodCode} onChange={event => setReport(value => ({ ...value, periodCode: event.target.value }))}><option value="DAILY">يومي</option><option value="WEEKLY">أسبوعي</option><option value="MONTHLY">شهري</option><option value="QUARTERLY">ربع سنوي</option><option value="HALF_YEARLY">نصف سنوي</option><option value="YEARLY">سنوي</option></select></label>
        <label>من<input type="date" value={report.periodStart} onChange={event => setReport(value => ({ ...value, periodStart: event.target.value }))} /></label>
        <label>إلى<input type="date" value={report.periodEnd} onChange={event => setReport(value => ({ ...value, periodEnd: event.target.value }))} /></label>
        <a className="button button--primary" href={reportReady ? `/api/admin/workflow-audit.pdf?${reportQuery}` : undefined} target="_blank" rel="noreferrer" aria-disabled={!reportReady}><FileDown size={17} /> إنشاء PDF</a>
      </div>
    </section>
    <section className="panel"><form className="audit-filters" onSubmit={event => { event.preventDefault(); setSkip(0); setApplied(filters) }}>
      <label>نوع الحدث<input value={filters.eventType} maxLength={120} onChange={event => setFilters(current => ({ ...current, eventType: event.target.value }))} placeholder="مثال: USER_CREATED" /></label>
      <label>المنفذ<input value={filters.actor} maxLength={120} onChange={event => setFilters(current => ({ ...current, actor: event.target.value }))} placeholder="الاسم أو المستخدم" /></label>
      <label>من<input type="date" value={filters.from} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} /></label>
      <label>إلى<input type="date" value={filters.to} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} /></label>
      <button className="button button--primary"><Filter size={17} /> تطبيق</button>
    </form></section>
    <section className="panel"><div className="panel__header"><div><h2>الأحداث</h2><p>الصفحة {Math.floor(skip / top) + 1} · حتى {top} حدثاً.</p></div></div>
      {loading ? <div className="loading-panel"><span className="spinner" /> جارٍ التحميل...</div> : events.length === 0 ? <EmptyState icon={ShieldCheck} title="لا توجد أحداث مطابقة" body="غيّر المرشحات أو انتقل إلى صفحة سابقة." /> : <div className="table-scroll"><table className="data-table audit-table"><thead><tr><th>الوقت</th><th>الحدث</th><th>المنفذ</th><th>وحدة المسار</th><th>الارتباط</th><th>تفاصيل آمنة</th></tr></thead><tbody>{events.map(item => <tr key={item.id}><td>{date(item.createdAt)}</td><td><strong className="mono">{item.eventType}</strong></td><td>{item.actorName ?? 'النظام'}<small>{item.ipAddress ?? '—'}</small></td><td>{item.routingUnitName ?? '—'}</td><td className="mono">{item.correlationId ?? '—'}</td><td><details><summary>عرض</summary><pre>{JSON.stringify(item.details, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}
      <div className="pagination"><button className="button button--secondary" disabled={skip === 0 || loading} onClick={() => setSkip(value => Math.max(0, value - top))}><ChevronRight size={17} /> السابق</button><span>{skip + 1}–{skip + events.length}</span><button className="button button--secondary" disabled={events.length < top || loading} onClick={() => setSkip(value => value + top)}>التالي <ChevronLeft size={17} /></button></div>
    </section>
  </div>
}

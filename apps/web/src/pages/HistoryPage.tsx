import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Filter, History, Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiRequest } from '../api/client'
import type { RoutingUnit } from '../api/admin-types'
import type { WorkflowHistoryItem } from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'

const top = 50
function date(value: string): string { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }

export function HistoryPage(): React.JSX.Element {
  const [urlParams, setUrlParams] = useSearchParams()
  const [units, setUnits] = useState<RoutingUnit[]>([])
  const [items, setItems] = useState<WorkflowHistoryItem[]>([])
  const [filters, setFilters] = useState({ q: urlParams.get('q') ?? '', requestType: '', status: '', routingUnitId: '', personnelNumber: '', from: '', to: '' })
  const [applied, setApplied] = useState(filters)
  const [skip, setSkip] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null)
    const query = new URLSearchParams({ skip: String(skip), top: String(top) })
    for (const [key, value] of Object.entries(applied)) if (value) query.set(key, value)
    try { setItems(await apiRequest<WorkflowHistoryItem[]>(`/api/workflow/history?${query}`)) }
    catch { setError('تعذر تنفيذ البحث في نطاق صلاحياتك.') }
    finally { setLoading(false) }
  }, [applied, skip])

  useEffect(() => { void load() }, [load])
  useEffect(() => { apiRequest<RoutingUnit[]>('/api/reference/routing-units').then(setUnits).catch(() => undefined) }, [])

  function apply(event: React.FormEvent): void {
    event.preventDefault(); setSkip(0); setApplied(filters)
    const next = new URLSearchParams(); if (filters.q) next.set('q', filters.q); setUrlParams(next, { replace: true })
  }

  return <div className="page-stack">
    <header className="page-heading"><div><p>الطلبات / السجل</p><h1>البحث وسجل الطلبات</h1><span>النتائج مقيدة بالطلبات التي تملكها أو شاركت فيها تحت الدور النشط فقط.</span></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><form className="history-filters" onSubmit={apply}>
      <label className="history-query">رقم الطلب أو رقم العامل<input type="search" value={filters.q} maxLength={120} onChange={event => setFilters(value => ({ ...value, q: event.target.value }))} placeholder="بحث مقيد..." /></label>
      <label>النوع<select value={filters.requestType} onChange={event => setFilters(value => ({ ...value, requestType: event.target.value }))}><option value="">الكل</option><option value="PROMOTION">ترقية</option><option value="SECONDMENT">ندب</option></select></label>
      <label>الحالة<select value={filters.status} onChange={event => setFilters(value => ({ ...value, status: event.target.value }))}><option value="">الكل</option><option value="DRAFT">مسودة</option><option value="IN_PROGRESS">جارٍ</option><option value="RETURNED">مرتجع</option><option value="COMPLETED">مكتمل</option><option value="CANCELLED">ملغي</option></select></label>
      <label>وحدة المسار<select value={filters.routingUnitId} onChange={event => setFilters(value => ({ ...value, routingUnitId: event.target.value }))}><option value="">الكل</option>{units.filter(unit => unit.isActive).map(unit => <option key={unit.id} value={unit.id}>{unit.nameAr}</option>)}</select></label>
      <label>رقم العامل (مطابقة تامة)<input value={filters.personnelNumber} maxLength={120} onChange={event => setFilters(value => ({ ...value, personnelNumber: event.target.value }))} /></label>
      <label>من<input type="date" value={filters.from} onChange={event => setFilters(value => ({ ...value, from: event.target.value }))} /></label>
      <label>إلى<input type="date" value={filters.to} onChange={event => setFilters(value => ({ ...value, to: event.target.value }))} /></label>
      <button className="button button--primary"><Filter size={17} /> تطبيق المرشحات</button>
    </form></section>
    <section className="panel"><div className="panel__header"><div><h2>النتائج</h2><p>الصفحة {Math.floor(skip / top) + 1} · بحد أقصى {top} طلبًا.</p></div><Search size={21} /></div>
      {loading ? <div className="loading-panel"><span className="spinner" /> جارٍ البحث...</div> : items.length === 0 ? <EmptyState icon={History} title="لا توجد نتائج ضمن نطاقك" body="غيّر المرشحات، أو لا توجد طلبات شاركت فيها بهذا الدور." /> : <div className="table-scroll"><table className="data-table history-table"><thead><tr><th>الطلب</th><th>النوع</th><th>الحالة</th><th>المرحلة</th><th>الوحدة</th><th>العاملون</th><th>آخر تحديث</th><th>إجراء</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
        <td><strong className="mono">{item.requestNumber}</strong><small>دورة {item.cycleYear} · تكرار {item.currentIterationNo}</small></td>
        <td>{item.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</td><td><StatusBadge status={item.status} /></td><td>{item.currentStage}</td>
        <td>{item.routingUnit?.nameAr ?? '—'}</td><td>{item.candidateCount}</td><td>{date(item.updatedAt)}</td>
        <td><Link className="table-action" to={`/requests/${item.id}`}>فتح الطلب <ChevronLeft size={16} /></Link></td>
      </tr>)}</tbody></table></div>}
      <div className="pagination"><button className="button button--secondary" disabled={skip === 0 || loading} onClick={() => setSkip(value => Math.max(0, value - top))}><ChevronRight size={17} /> السابق</button><span>{items.length ? `${skip + 1}–${skip + items.length}` : '0'}</span><button className="button button--secondary" disabled={items.length < top || loading} onClick={() => setSkip(value => value + top)}>التالي <ChevronLeft size={17} /></button></div>
    </section>
  </div>
}

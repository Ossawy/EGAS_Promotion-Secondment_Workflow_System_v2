import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ChevronDown, ChevronUp, FileSearch, Filter, Printer, RotateCcw, ShieldCheck, UserRound } from 'lucide-react'
import { adminApi } from '../../api/endpoints'
import type { AdminAuditEvent, AdminAuditQuery } from '../../api/admin-types'
import { arabicErrorMessage } from '../../api/messages'
import { EmptyState } from '../../components/EmptyState'
import { ADMIN_AUDIT_EVENT_LABELS, adminAuditEventLabel } from '../../api/admin-audit-labels'

const PAGE_SIZE = 25
const EMPTY_FILTERS = { eventType: '', actor: '', from: '', to: '' }
type AuditFilters = typeof EMPTY_FILTERS

const FIELD_LABELS: Record<string, string> = { displayName: 'الاسم المعروض', jobTitle: 'المسمى الوظيفي', staffIdentifier: 'الرقم الوظيفي', accountType: 'نوع الحساب', unitId: 'الوحدة التشغيلية' }

function eventLabel(value: string): string {
  return adminAuditEventLabel(value)
}

function abbreviatedId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function reportFilterSummary(filters: AuditFilters): string {
  const parts = [
    filters.eventType ? `نوع الحدث: ${eventLabel(filters.eventType)}` : null,
    filters.actor.trim() ? `المنفذ: ${filters.actor.trim()}` : null,
    filters.from || filters.to ? `الفترة: ${filters.from || 'البداية'} إلى ${filters.to || 'اليوم'}` : null
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' — ') : 'الفلاتر: جميع الأحداث والتواريخ والمنفذين'
}

function detailsSummary(event: AdminAuditEvent): string {
  const changed = Array.isArray(event.details.changedFields) ? event.details.changedFields.filter((field): field is string => typeof field === 'string') : []
  if (changed.length) return `تم تعديل: ${changed.map(field => FIELD_LABELS[field] ?? 'بيانات الحساب').join('، ')}`
  if (typeof event.details.reason === 'string' && event.details.reason.trim()) return `السبب: ${event.details.reason}`
  if (typeof event.details.personnelNumber === 'string') return `رقم العامل: ${event.details.personnelNumber}`
  if (typeof event.details.positionTitle === 'string') return `الوظيفة: ${event.details.positionTitle}`
  if (typeof event.details.snapshotYear === 'number') return `سنة البيانات: ${event.details.snapshotYear}`
  if (event.requestNumber) return `مرتبط بالطلب ${event.requestNumber}`
  if (event.subjectLabel) return `تم تسجيل الإجراء على ${event.subjectLabel}`
  return 'تم تسجيل الإجراء بنجاح.'
}

function toQuery(filters: AuditFilters, skip: number, top = PAGE_SIZE): AdminAuditQuery {
  return { skip, top, eventType: filters.eventType, actor: filters.actor.trim(), from: filters.from, to: filters.to }
}

export function AdminAuditPage(): React.JSX.Element {
  const [searchParams] = useSearchParams()
  const searchActor = (searchParams.get('actor') ?? '').slice(0, 120)
  const [items, setItems] = useState<AdminAuditEvent[]>([])
  const [total, setTotal] = useState(0)
  const [skip, setSkip] = useState(0)
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS)
  const [activeFilters, setActiveFilters] = useState<AuditFilters>(EMPTY_FILTERS)
  const [printOpen, setPrintOpen] = useState(false)
  const [printFilters, setPrintFilters] = useState<AuditFilters>(EMPTY_FILTERS)
  const [printPending, setPrintPending] = useState(false)
  const [reportFilters, setReportFilters] = useState<AuditFilters | null>(null)
  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await adminApi.audit(toQuery(activeFilters, skip))
      setItems(page.items); setTotal(page.total); setError(null)
    } catch (requestError) { setError(arabicErrorMessage(requestError)) }
    finally { setLoading(false) }
  }, [activeFilters, skip])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!searchActor) return
    const filters = { ...EMPTY_FILTERS, actor: searchActor }
    setDraft(filters); setActiveFilters(filters); setSkip(0); setReportFilters(null)
  }, [searchActor])
  useEffect(() => {
    if (!printPending) return
    const timer = window.setTimeout(() => { window.print(); setPrintPending(false) }, 50)
    return () => window.clearTimeout(timer)
  }, [printPending])

  function updateFilter(setter: React.Dispatch<React.SetStateAction<AuditFilters>>, key: keyof AuditFilters, value: string): void {
    setter(current => ({ ...current, [key]: value }))
  }

  function applyFilters(event: React.FormEvent): void {
    event.preventDefault(); setSkip(0); setActiveFilters({ ...draft }); setReportFilters(null)
  }

  function resetFilters(): void {
    setDraft(EMPTY_FILTERS); setActiveFilters(EMPTY_FILTERS); setSkip(0); setReportFilters(null)
  }

  async function printReport(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (printFilters.from && printFilters.to && printFilters.from > printFilters.to) { setError('تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.'); return }
    setPrinting(true)
    try {
      const report = await adminApi.audit(toQuery(printFilters, 0, 100))
      setItems(report.items); setTotal(report.total); setSkip(0); setReportFilters({ ...printFilters }); setError(null); setPrintPending(true)
    } catch (requestError) { setError(arabicErrorMessage(requestError)) }
    finally { setPrinting(false) }
  }

  return <div className="page-stack admin-audit-page">
    <header className="page-heading audit-page-heading"><div><p>إيجاس / إدارة النظام</p><h1>سجل التدقيق</h1><span>سجل واضح لأحداث الإدارة والأمن، يعرض من نفذ الإجراء وما الذي تأثر ومتى.</span></div><button type="button" className="button button--primary audit-no-print" aria-expanded={printOpen} onClick={() => { setPrintOpen(value => !value); setPrintFilters({ ...activeFilters }) }}><Printer size={18} /> طباعة / تصدير PDF {printOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></header>

    {printOpen && <section className="panel audit-print-panel audit-no-print" aria-label="خيارات طباعة سجل التدقيق">
      <div className="panel__header"><div><h2>إعداد تقرير الطباعة</h2><p>لن تظهر هذه الخيارات في التقرير المطبوع. يصدّر التقرير حتى 100 حدث مع إظهار العدد الكلي وأي اقتطاع بوضوح.</p></div><Printer size={22} /></div>
      <form className="audit-filter-grid audit-print-grid" onSubmit={event => void printReport(event)}>
        <FilterFields value={printFilters} onChange={(key, value) => updateFilter(setPrintFilters, key, value)} />
        <div className="audit-filter-actions"><button className="button button--primary" disabled={printing}>{printing ? 'جارٍ تجهيز التقرير...' : 'طباعة التقرير'}</button><button type="button" className="button button--secondary" onClick={() => setPrintOpen(false)}>إلغاء</button></div>
      </form>
    </section>}

    <section className="panel audit-no-print">
      <div className="panel__header"><div><h2>البحث والتصفية</h2><p>استخدم اسماً أو فترة زمنية أو نوع حدث للوصول إلى السجل المطلوب.</p></div><Filter size={21} /></div>
      <form className="audit-filter-grid" onSubmit={applyFilters}>
        <FilterFields value={draft} onChange={(key, value) => updateFilter(setDraft, key, value)} />
        <div className="audit-filter-actions"><button className="button button--primary"><Filter size={17} /> تطبيق</button><button type="button" className="button button--secondary" onClick={resetFilters}><RotateCcw size={17} /> مسح</button></div>
      </form>
    </section>

    <section className="panel audit-results-panel">
      <div className="panel__header"><div><h2>الأحداث</h2><p>{total} حدثاً مطابقاً{reportFilters ? ` — يتضمن تقرير الطباعة ${items.length} حدثاً` : ''}</p></div><ShieldCheck size={22} /></div>
      {reportFilters && total > items.length && <div className="alert alert--warning"><strong>تنبيه: التقرير مقتطع</strong><span>يعرض التقرير {items.length} حدثاً من أصل {total} حدثاً مطابقاً. لم تُزل حدود الخادم الآمنة، والفلاتر المختارة محفوظة أدناه.</span></div>}
      <div className="audit-print-only"><h1>تقرير سجل التدقيق الإداري</h1><p>تاريخ إصدار التقرير: {new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full', timeStyle: 'short' }).format(new Date())}</p><p>{reportFilters ? reportFilterSummary(reportFilters) : reportFilterSummary(activeFilters)}</p><p><strong>عدد الأحداث المطابقة:</strong> {total} — <strong>عدد الأحداث المصدّرة:</strong> {items.length}</p>{reportFilters && total > items.length && <p className="audit-truncation-warning"><strong>تنبيه:</strong> هذا التقرير مقتطع ويعرض أول {items.length} حدثاً فقط من أصل {total} وفق ترتيب الأحدث أولاً.</p>}</div>
      {error ? <div className="empty-state"><strong className="error">{error}</strong><button className="button button--secondary audit-no-print" onClick={() => void load()}>إعادة المحاولة</button></div> : loading ? <div className="loading-panel"><span className="spinner" /> جارٍ تحميل سجل التدقيق...</div> : items.length === 0 ? <EmptyState icon={FileSearch} title="لا توجد أحداث مطابقة" body="جرّب تغيير نوع الحدث أو اسم المنفذ أو الفترة الزمنية." /> : <div className="table-scroll"><table className="data-table audit-table"><thead><tr><th>الوقت</th><th>الإجراء</th><th>المنفذ</th><th>العنصر المتأثر</th><th>ملخص واضح</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><time>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</time></td><td><span className="audit-event"><ShieldCheck size={17} /><strong>{eventLabel(item.eventType)}</strong></span></td><td><span className="audit-actor"><UserRound size={16} /><span><strong>{item.actorDisplayName ?? (item.actorUserId ? `حساب محفوظ ${abbreviatedId(item.actorUserId)}` : 'النظام')}</strong>{item.actorUsername && <small>@{item.actorUsername}</small>}{(item.actorJobTitle || item.actorUnitName) && <small>{[item.actorJobTitle, item.actorUnitName].filter(Boolean).join(' — ')}</small>}</span></span></td><td><strong>{item.subjectLabel ?? (item.subjectId ? `سجل محفوظ ${abbreviatedId(item.subjectId)}` : 'سجل نظامي')}</strong>{item.requestNumber && item.subjectLabel !== item.requestNumber && <small>طلب {item.requestNumber}</small>}</td><td>{detailsSummary(item)}</td></tr>)}</tbody></table></div>}
      <footer className="pagination audit-no-print"><span>عرض {total === 0 ? 0 : skip + 1}–{Math.min(skip + PAGE_SIZE, total)} من {total}</span><div><button className="button button--secondary" disabled={skip === 0 || Boolean(reportFilters)} onClick={() => setSkip(value => Math.max(0, value - PAGE_SIZE))}>السابق</button><button className="button button--secondary" disabled={skip + PAGE_SIZE >= total || Boolean(reportFilters)} onClick={() => setSkip(value => value + PAGE_SIZE)}>التالي</button></div></footer>
    </section>
  </div>
}

function FilterFields({ value, onChange }: { value: AuditFilters, onChange: (key: keyof AuditFilters, value: string) => void }): React.JSX.Element {
  return <>
    <label><span>نوع الحدث</span><select value={value.eventType} onChange={event => onChange('eventType', event.target.value)}><option value="">كل أنواع الأحداث</option>{Object.entries(ADMIN_AUDIT_EVENT_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
    <label><span>المنفذ</span><div className="audit-input-with-icon"><UserRound size={17} /><input value={value.actor} onChange={event => onChange('actor', event.target.value)} placeholder="الاسم أو اسم المستخدم" maxLength={120} /></div></label>
    <label><span>من تاريخ</span><div className="audit-input-with-icon"><CalendarDays size={17} /><input type="date" value={value.from} onChange={event => onChange('from', event.target.value)} /></div></label>
    <label><span>إلى تاريخ</span><div className="audit-input-with-icon"><CalendarDays size={17} /><input type="date" value={value.to} onChange={event => onChange('to', event.target.value)} /></div></label>
  </>
}

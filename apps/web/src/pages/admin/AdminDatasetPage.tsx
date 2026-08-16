import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, FileSpreadsheet, Plus, RefreshCcw, Route, ShieldCheck } from 'lucide-react'
import { ApiError, apiJson, apiRequest } from '../../api/client'
import type { ImportBatch, RoutingAlias, RoutingUnit } from '../../api/admin-types'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'

type Unmapped = { sourceLabel: string, rowCount: number }
function message(error: unknown): string { return error instanceof ApiError ? error.message : 'تعذر إتمام العملية.' }
function date(value: string): string { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }

export function AdminDatasetPage(): React.JSX.Element {
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [aliases, setAliases] = useState<RoutingAlias[]>([])
  const [units, setUnits] = useState<RoutingUnit[]>([])
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null)
  const [unmapped, setUnmapped] = useState<Unmapped[]>([])
  const [aliasOpen, setAliasOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load(): Promise<void> {
    try {
      const [loadedBatches, loadedAliases, loadedUnits] = await Promise.all([
        apiRequest<ImportBatch[]>('/api/admin/import-batches?top=100'),
        apiRequest<RoutingAlias[]>('/api/admin/routing-aliases?activeOnly=false'),
        apiRequest<RoutingUnit[]>('/api/reference/routing-units')
      ])
      setBatches(loadedBatches); setAliases(loadedAliases); setUnits(loadedUnits)
      if (!selectedBatch && loadedBatches[0]) setSelectedBatch(loadedBatches[0].id)
    } catch (caught) { setError(message(caught)) }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!selectedBatch) { setUnmapped([]); return }
    apiRequest<Unmapped[]>(`/api/admin/import-batches/${selectedBatch}/unmapped-routing-labels`).then(setUnmapped).catch(caught => setError(message(caught)))
  }, [selectedBatch, batches])
  const current = useMemo(() => batches.find(batch => batch.id === selectedBatch) ?? null, [batches, selectedBatch])

  async function batchAction(action: 'revalidate' | 'activate'): Promise<void> {
    if (!current) return
    setBusy(true); setError(null)
    try { await apiJson(`/api/admin/import-batches/${current.id}/${action}`, 'POST', {}); await load() }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  async function createAlias(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setBusy(true); setError(null)
    const data = new FormData(event.currentTarget)
    try {
      await apiJson('/api/admin/routing-aliases', 'POST', { sourceLabel: data.get('sourceLabel'), routingUnitId: data.get('routingUnitId'), notes: data.get('notes') || null })
      setAliasOpen(false); await load()
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  async function deactivateAlias(id: string): Promise<void> {
    setBusy(true); setError(null)
    try { await apiJson(`/api/admin/routing-aliases/${id}/deactivate`, 'POST', {}); await load() }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  return <div className="page-stack">
    <header className="page-heading"><div><p>إدارة النظام / البيانات السنوية</p><h1>الدفعات والتحقق والمسارات</h1><span>الاستيراد الأولي يظل عملية مشغل محلية محكومة، ولا توجد نقطة رفع عبر المتصفح.</span></div><button className="button button--secondary" onClick={() => void load()}><RefreshCcw size={18} /> تحديث</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="state-banner state-banner--info"><ShieldCheck size={21} /><div><strong>حد استيراد آمن</strong><span>استخدم أمر المشغل <span className="mono">npm run data:import -- --file &lt;path&gt; --year &lt;year&gt; --operator &lt;username&gt;</span>. لا تُرسل مسارات ملفات أو مصنفات من هذه الشاشة.</span></div></div>
    <section className="panel"><div className="panel__header"><div><h2>دفعات الاستيراد</h2><p>الحالة وأعداد التحقق فقط؛ لا تظهر أسماء أو أرقام العاملين.</p></div><Database /></div>
      {batches.length === 0 ? <EmptyState icon={FileSpreadsheet} title="لا توجد دفعات" body="شغّل الاستيراد المحكوم عند استلام ملف EGAS المعتمد." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>السنة / الملف</th><th>الحالة</th><th>الإجمالي</th><th>صالح</th><th>تحذير</th><th>محظور</th><th>تاريخ الاستيراد</th><th>إجراء</th></tr></thead><tbody>{batches.map(batch => <tr key={batch.id} className={selectedBatch === batch.id ? 'is-selected' : ''}><td><strong>{batch.snapshotYear}</strong><small>{batch.sourceFilename}</small></td><td><StatusBadge status={batch.status === 'ACTIVATED' ? 'COMPLETED' : batch.status === 'FAILED' ? 'CANCELLED' : batch.status === 'VALIDATED' ? 'IN_PROGRESS' : 'DRAFT'} label={batch.status} /></td><td>{batch.totalRows}</td><td>{batch.validRows}</td><td>{batch.warningRows}</td><td>{batch.blockedRows}</td><td>{date(batch.importedAt)}</td><td><button className="table-action" onClick={() => setSelectedBatch(batch.id)}>تفاصيل</button></td></tr>)}</tbody></table></div>}
    </section>
    {current && <section className="dataset-detail-grid">
      <article className="panel"><div className="panel__header"><div><h2>نتيجة الدفعة {current.snapshotYear}</h2><p className="mono">{current.id}</p></div><FileSpreadsheet /></div><div className="validation-counts"><span><CheckCircle2 /> صالح<strong>{current.validRows}</strong></span><span><AlertTriangle /> تحذير<strong>{current.warningRows}</strong></span><span><AlertTriangle /> محظور<strong>{current.blockedRows}</strong></span></div><div className="form-actions"><button className="button button--secondary" disabled={busy || current.status === 'ACTIVATED'} onClick={() => void batchAction('revalidate')}><RefreshCcw size={17} /> إعادة التحقق</button><button className="button button--primary" disabled={busy || current.status !== 'VALIDATED' || current.blockedRows > 0 || current.totalRows === 0} onClick={() => void batchAction('activate')}><ShieldCheck size={17} /> تفعيل اللقطة</button></div></article>
      <article className="panel"><div className="panel__header"><div><h2>مسارات غير مطابقة</h2><p>تسميات مميزة وعدد الصفوف فقط.</p></div><Route /></div>{unmapped.length === 0 ? <EmptyState icon={CheckCircle2} title="لا توجد تسميات غير مطابقة" body="كل تسميات المسار في هذه الدفعة محلولة صراحةً." /> : <div className="compact-list">{unmapped.map(item => <article key={item.sourceLabel}><strong>{item.sourceLabel}</strong><span>{item.rowCount} صف</span><button className="table-action" onClick={() => setAliasOpen(true)}>إضافة بديل</button></article>)}</div>}</article>
    </section>}
    <section className="panel"><div className="panel__header"><div><h2>بدائل تسميات المسار</h2><p>مطابقة تامة فقط من تسمية المصدر إلى وحدة نشطة.</p></div><button className="button button--secondary" onClick={() => setAliasOpen(value => !value)}><Plus size={17} /> بديل جديد</button></div>
      {aliasOpen && <form className="admin-form admin-form--inline" onSubmit={event => void createAlias(event)}><label>تسمية المصدر<input name="sourceLabel" required maxLength={300} /></label><label>وحدة المسار<select name="routingUnitId" required><option value="">اختر الوحدة</option>{units.filter(unit => unit.isActive).map(unit => <option key={unit.id} value={unit.id}>{unit.nameAr}</option>)}</select></label><label>ملاحظات<input name="notes" maxLength={2000} /></label><button className="button button--primary" disabled={busy}>حفظ البديل</button></form>}
      {aliases.length === 0 ? <EmptyState icon={Route} title="لا توجد بدائل" body="الأسماء المطابقة للوحدات النشطة لا تحتاج إلى بديل." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>تسمية المصدر</th><th>وحدة المسار</th><th>الحالة</th><th>التكوين</th><th>إجراء</th></tr></thead><tbody>{aliases.map(alias => <tr key={alias.id}><td>{alias.sourceLabel}</td><td>{alias.routingUnit.nameAr}</td><td><StatusBadge status={alias.isActive ? 'COMPLETED' : 'CANCELLED'} label={alias.isActive ? 'نشط' : 'غير نشط'} /></td><td>{date(alias.configuredAt)}</td><td>{alias.isActive && <button className="danger-action" disabled={busy} onClick={() => void deactivateAlias(alias.id)}>إلغاء</button>}</td></tr>)}</tbody></table></div>}
    </section>
  </div>
}

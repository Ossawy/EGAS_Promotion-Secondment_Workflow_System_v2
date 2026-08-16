import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Plus, ShieldCheck, UserRoundCog } from 'lucide-react'
import { ApiError, apiJson, apiRequest } from '../../api/client'
import type { AdminUser, AuthorityAssignment, Delegation, RoutingUnit } from '../../api/admin-types'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'

function message(error: unknown): string { return error instanceof ApiError ? error.message : 'تعذر إتمام العملية.' }
function day(value: string | null): string { return value ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value)) : 'مفتوح' }

export function AdminAuthoritiesPage(): React.JSX.Element {
  const [assignments, setAssignments] = useState<AuthorityAssignment[]>([])
  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [units, setUnits] = useState<RoutingUnit[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [tab, setTab] = useState<'assignments' | 'delegations'>('assignments')
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load(): Promise<void> {
    try {
      const [loadedAssignments, loadedDelegations, loadedUnits, loadedUsers] = await Promise.all([
        apiRequest<AuthorityAssignment[]>('/api/admin/authority-assignments?activeOnly=false'),
        apiRequest<Delegation[]>('/api/admin/delegations?activeOnly=false'),
        apiRequest<RoutingUnit[]>('/api/reference/routing-units'),
        apiRequest<AdminUser[]>('/api/admin/users?top=100')
      ])
      setAssignments(loadedAssignments); setDelegations(loadedDelegations); setUnits(loadedUnits); setUsers(loadedUsers)
    } catch (caught) { setError(message(caught)) }
  }

  useEffect(() => { void load() }, [])
  const authorityUsers = useMemo(() => users.filter(user => user.isActive && user.roles.some(role => role.role === 'APPROVING_AUTHORITY' && role.isActive)), [users])
  const userName = (id: string): string => users.find(user => user.id === id)?.displayName ?? id
  const unitName = (id: string): string => units.find(unit => unit.id === id)?.nameAr ?? id

  async function create(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setBusy(true); setError(null)
    const data = new FormData(event.currentTarget)
    try {
      if (tab === 'assignments') {
        await apiJson('/api/admin/authority-assignments', 'POST', {
          routingUnitId: data.get('routingUnitId'), userAccountId: data.get('userAccountId'),
          authorityKind: data.get('authorityKind'), authorityJobTitle: data.get('authorityJobTitle'),
          isPrimary: data.get('isPrimary') === 'on', validFrom: data.get('validFrom'),
          validTo: data.get('validTo') || null, notes: data.get('notes') || null
        })
      } else {
        const from = String(data.get('validFrom'))
        const to = String(data.get('validTo'))
        await apiJson('/api/admin/delegations', 'POST', {
          assignmentId: data.get('assignmentId'), delegatedUserId: data.get('delegatedUserId'),
          validFrom: new Date(from).toISOString(), validTo: to ? new Date(to).toISOString() : null,
          reason: data.get('reason') || null
        })
      }
      setCreateOpen(false); await load()
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  async function deactivate(path: string, version: number): Promise<void> {
    setBusy(true); setError(null)
    try { await apiJson(path, 'POST', { expectedVersion: version }); await load() }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  return <div className="page-stack">
    <header className="page-heading"><div><p>إدارة النظام / الاعتماد</p><h1>تعيينات السلطة والتفويض</h1><span>التعيين أو التفويض لا يمنح صلاحية إلا لدور سلطة اعتماد نشط.</span></div><button className="button button--primary" onClick={() => setCreateOpen(value => !value)}><Plus size={18} /> إضافة {tab === 'assignments' ? 'تعيين' : 'تفويض'}</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="segmented-tabs" role="tablist"><button className={tab === 'assignments' ? 'is-active' : ''} onClick={() => { setTab('assignments'); setCreateOpen(false) }}>تعيينات السلطة</button><button className={tab === 'delegations' ? 'is-active' : ''} onClick={() => { setTab('delegations'); setCreateOpen(false) }}>التفويضات المؤقتة</button></div>
    {createOpen && <section className="panel"><div className="panel__header"><div><h2>{tab === 'assignments' ? 'تعيين سلطة اعتماد' : 'تفويض مؤقت'}</h2><p>التواريخ والتحقق من الأهلية تُراجع مرة أخرى في الخادم.</p></div>{tab === 'assignments' ? <ShieldCheck /> : <CalendarClock />}</div>
      <form className="admin-form" onSubmit={event => void create(event)}>
        {tab === 'assignments' ? <>
          <label>وحدة المسار<select name="routingUnitId" required><option value="">اختر الوحدة</option>{units.filter(unit => unit.isActive).map(unit => <option key={unit.id} value={unit.id}>{unit.nameAr}</option>)}</select></label>
          <label>حساب السلطة<select name="userAccountId" required><option value="">اختر الحساب</option>{authorityUsers.map(user => <option key={user.id} value={user.id}>{user.displayName} · {user.username}</option>)}</select></label>
          <label>نوع السلطة<select name="authorityKind" required><option value="DEPUTY">نائب</option><option value="ASSISTANT">مساعد</option><option value="ACTING_DEPUTY">قائم بأعمال نائب</option><option value="ACTING_ASSISTANT">قائم بأعمال مساعد</option><option value="OTHER">أخرى</option></select></label>
          <label>المسمى الوظيفي<input name="authorityJobTitle" required maxLength={500} /></label>
          <label>ساري من<input name="validFrom" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label><label>ساري إلى<input name="validTo" type="date" /></label>
          <label className="check-field"><input name="isPrimary" type="checkbox" defaultChecked /> التعيين الأساسي للوحدة</label><label>ملاحظات<textarea name="notes" maxLength={2000} rows={2} /></label>
        </> : <>
          <label>التعيين الأساسي<select name="assignmentId" required><option value="">اختر التعيين</option>{assignments.filter(item => item.isActive).map(item => <option key={item.id} value={item.id}>{unitName(item.routingUnitId)} · {userName(item.userAccountId)}</option>)}</select></label>
          <label>الحساب المفوّض إليه<select name="delegatedUserId" required><option value="">اختر الحساب</option>{authorityUsers.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label>
          <label>بداية التفويض<input name="validFrom" type="datetime-local" required /></label><label>نهاية التفويض<input name="validTo" type="datetime-local" /></label><label className="admin-form__wide">السبب<textarea name="reason" maxLength={2000} rows={2} /></label>
        </>}
        <div className="form-actions form-actions--wide"><button className="button button--secondary" type="button" onClick={() => setCreateOpen(false)}>إلغاء</button><button className="button button--primary" disabled={busy}>حفظ</button></div>
      </form>
    </section>}
    <section className="panel"><div className="panel__header"><div><h2>{tab === 'assignments' ? 'خريطة سلطة الاعتماد' : 'سجل التفويضات'}</h2><p>تظهر السجلات النشطة وغير النشطة لحفظ السياق الإداري.</p></div></div>
      {tab === 'assignments' ? assignments.length === 0 ? <EmptyState icon={ShieldCheck} title="لا توجد تعيينات" body="تغطية السلطة ستظل غير مكتملة حتى إضافة التعيينات الحقيقية." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>وحدة المسار</th><th>الحساب</th><th>النوع / المسمى</th><th>السريان</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{assignments.map(item => <tr key={item.id}><td>{unitName(item.routingUnitId)}</td><td>{userName(item.userAccountId)}</td><td>{item.authorityKind}<small>{item.authorityJobTitle}{item.isPrimary ? ' · أساسي' : ''}</small></td><td>{day(item.validFrom)} — {day(item.validTo)}</td><td><StatusBadge status={item.isActive ? 'COMPLETED' : 'CANCELLED'} label={item.isActive ? 'نشط' : 'غير نشط'} /></td><td>{item.isActive && <button className="danger-action" disabled={busy} onClick={() => void deactivate(`/api/admin/authority-assignments/${item.id}/deactivate`, item.version)}>إلغاء التفعيل</button>}</td></tr>)}</tbody></table></div>
      : delegations.length === 0 ? <EmptyState icon={UserRoundCog} title="لا توجد تفويضات" body="أضف تفويضاً مؤقتاً فقط عند وجود قرار حقيقي وتواريخ محددة." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>التعيين</th><th>المفوّض إليه</th><th>السريان</th><th>السبب</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{delegations.map(item => <tr key={item.id}><td>{unitName(assignments.find(value => value.id === item.authorityAssignmentId)?.routingUnitId ?? '')}</td><td>{userName(item.delegatedUserId)}</td><td>{day(item.validFrom)} — {day(item.validTo)}</td><td>{item.reason ?? '—'}</td><td><StatusBadge status={item.isActive ? 'COMPLETED' : 'CANCELLED'} label={item.isActive ? 'نشط' : 'غير نشط'} /></td><td>{item.isActive && <button className="danger-action" disabled={busy} onClick={() => void deactivate(`/api/admin/delegations/${item.id}/deactivate`, item.version)}>إلغاء التفعيل</button>}</td></tr>)}</tbody></table></div>}
    </section>
  </div>
}

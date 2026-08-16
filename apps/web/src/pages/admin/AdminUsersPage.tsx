import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, LockOpen, Plus, Search, UserCog, UserRoundCheck, UserRoundX } from 'lucide-react'
import { ApiError, apiJson, apiRequest } from '../../api/client'
import type { AdminUser } from '../../api/admin-types'
import type { Role } from '../../api/types'
import { useAuth } from '../../auth/AuthProvider'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'

const roles: Array<{ value: Role, label: string }> = [
  { value: 'ADMIN', label: 'مسؤول النظام' }, { value: 'EMPLOYEE_AFFAIRS', label: 'شئون العاملين' },
  { value: 'ORGANIZATION', label: 'التنظيم' }, { value: 'APPROVING_AUTHORITY', label: 'سلطة الاعتماد' }
]

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : 'تعذر إتمام العملية.'
}

export function AdminUsersPage(): React.JSX.Element {
  const { user: actor } = useAuth()
  const canManageAdmins = Boolean(actor?.availableRoles.find(item => item.role === 'ADMIN')?.canManageAdmins)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const selected = useMemo(() => users.find(item => item.id === selectedId) ?? null, [selectedId, users])

  const load = useCallback(async (query: string): Promise<void> => {
    setLoading(true)
    try { setUsers(await apiRequest<AdminUser[]>(`/api/admin/users?top=100&search=${encodeURIComponent(query.trim())}`)) }
    catch (caught) { setError(message(caught)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load('') }, [load])

  async function mutate(path: string, method: string, body: unknown): Promise<void> {
    setBusy(true); setError(null)
    try {
      const updated = await apiJson<AdminUser>(path, method, body)
      setUsers(current => current.map(item => item.id === updated.id ? updated : item))
      setTemporaryPassword('')
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  async function create(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setBusy(true); setError(null)
    const data = new FormData(event.currentTarget)
    const selectedRoles = roles.filter(role => data.getAll('roles').includes(role.value)).map(role => ({
      role: role.value, canManageAdmins: role.value === 'ADMIN' && data.get('canManageAdmins') === 'on'
    }))
    try {
      const created = await apiJson<AdminUser>('/api/admin/users', 'POST', {
        username: data.get('username'), staffIdentifier: data.get('staffIdentifier') || null,
        displayName: data.get('displayName'), jobTitle: data.get('jobTitle') || null,
        temporaryPassword: data.get('temporaryPassword'), isActive: true, roles: selectedRoles
      })
      setUsers(current => [...current, created].sort((a, b) => a.username.localeCompare(b.username)))
      setCreateOpen(false)
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  async function updateProfile(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selected) return
    const data = new FormData(event.currentTarget)
    await mutate(`/api/admin/users/${selected.id}`, 'PATCH', {
      expectedVersion: selected.version, staffIdentifier: data.get('staffIdentifier') || null,
      displayName: data.get('displayName'), jobTitle: data.get('jobTitle') || null
    })
  }

  async function toggleRole(role: Role, enabled: boolean, manageAdmins = false): Promise<void> {
    if (!selected) return
    if (enabled) await mutate(`/api/admin/users/${selected.id}/roles`, 'POST', { role, canManageAdmins: manageAdmins })
    else await mutate(`/api/admin/users/${selected.id}/roles/${role}`, 'DELETE', {})
  }

  return <div className="page-stack">
    <header className="page-heading"><div><p>إدارة النظام / الحسابات</p><h1>إدارة المستخدمين والأدوار</h1><span>كل عملية تفويض تمر بحماية backend وتلغي الجلسات المتأثرة.</span></div><button className="button button--primary" onClick={() => setCreateOpen(value => !value)}><Plus size={18} /> مستخدم جديد</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {createOpen && <section className="panel">
      <div className="panel__header"><div><h2>إنشاء حساب</h2><p>سيُطلب من المستخدم تغيير كلمة المرور المؤقتة عند أول دخول.</p></div><UserCog /></div>
      <form className="admin-form" onSubmit={event => void create(event)}>
        <label>اسم المستخدم<input name="username" required minLength={3} maxLength={120} autoComplete="off" /></label>
        <label>رقم الموظف<input name="staffIdentifier" maxLength={120} /></label>
        <label>الاسم المعروض<input name="displayName" required maxLength={300} /></label>
        <label>المسمى الوظيفي<input name="jobTitle" maxLength={300} /></label>
        <label>كلمة المرور المؤقتة<input name="temporaryPassword" type="password" required autoComplete="new-password" /></label>
        <fieldset className="admin-role-picker"><legend>الأدوار</legend>{roles.map(role => <label key={role.value}><input type="checkbox" name="roles" value={role.value} disabled={role.value === 'ADMIN' && !canManageAdmins} /> {role.label}</label>)}{canManageAdmins && <label><input type="checkbox" name="canManageAdmins" /> السماح بإدارة المسؤولين</label>}</fieldset>
        <div className="form-actions form-actions--wide"><button className="button button--secondary" type="button" onClick={() => setCreateOpen(false)}>إلغاء</button><button className="button button--primary" disabled={busy}>إنشاء الحساب</button></div>
      </form>
    </section>}

    <section className="panel">
      <div className="panel__header admin-list-header"><div><h2>الحسابات</h2><p>حتى 100 نتيجة لكل بحث مقيد.</p></div><form className="compact-search" onSubmit={event => { event.preventDefault(); void load(search) }}><Search size={18} /><input aria-label="بحث المستخدمين" value={search} onChange={event => setSearch(event.target.value)} placeholder="الاسم، المستخدم أو الرقم" /><button className="button button--secondary">بحث</button></form></div>
      {loading ? <div className="loading-panel"><span className="spinner" /> جارٍ التحميل...</div> : users.length === 0 ? <EmptyState icon={UserCog} title="لا توجد نتائج" body="غيّر عبارة البحث أو أنشئ حساباً جديداً." /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>المستخدم</th><th>الاسم</th><th>الأدوار النشطة</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{users.map(item => <tr key={item.id}>
        <td><strong className="mono">{item.username}</strong><small>{item.staffIdentifier ?? '—'}</small></td><td>{item.displayName}<small>{item.jobTitle ?? '—'}</small></td>
        <td><div className="role-chips">{item.roles.filter(role => role.isActive).map(role => <span key={role.role}>{roles.find(option => option.value === role.role)?.label ?? role.role}</span>)}</div></td>
        <td><StatusBadge status={!item.isActive ? 'CANCELLED' : item.isLocked ? 'RETURNED' : 'COMPLETED'} label={!item.isActive ? 'معطل' : item.isLocked ? 'مقفل' : 'نشط'} /></td>
        <td><button className="table-action" onClick={() => setSelectedId(item.id)}>إدارة</button></td>
      </tr>)}</tbody></table></div>}
    </section>

    {selected && <section className="panel admin-editor">
      <div className="panel__header"><div><h2>إدارة: {selected.displayName}</h2><p className="mono">{selected.username}</p></div><button className="icon-button" aria-label="إغلاق المحرر" onClick={() => setSelectedId(null)}>×</button></div>
      <form className="admin-form admin-form--profile" onSubmit={event => void updateProfile(event)}>
        <label>رقم الموظف<input name="staffIdentifier" defaultValue={selected.staffIdentifier ?? ''} /></label><label>الاسم المعروض<input name="displayName" required defaultValue={selected.displayName} /></label><label>المسمى الوظيفي<input name="jobTitle" defaultValue={selected.jobTitle ?? ''} /></label>
        <button className="button button--primary" disabled={busy}>حفظ البيانات</button>
      </form>
      <div className="admin-editor__section"><h3>الأدوار</h3><div className="role-controls">{roles.map(option => {
        const assignment = selected.roles.find(role => role.role === option.value && role.isActive)
        const disabled = selected.id === actor?.userId || (option.value === 'ADMIN' && !canManageAdmins)
        return <label key={option.value}><input type="checkbox" checked={Boolean(assignment)} disabled={disabled || busy} onChange={event => void toggleRole(option.value, event.target.checked, assignment?.canManageAdmins ?? false)} /> {option.label}{assignment?.canManageAdmins ? ' · إدارة المسؤولين' : ''}</label>
      })}</div></div>
      <div className="admin-editor__section"><h3>إجراءات الحساب</h3><div className="admin-account-actions">
        <button className="button button--secondary" disabled={busy || selected.id === actor?.userId} onClick={() => void mutate(`/api/admin/users/${selected.id}/${selected.isActive ? 'disable' : 'enable'}`, 'POST', { expectedVersion: selected.version })}>{selected.isActive ? <UserRoundX size={18} /> : <UserRoundCheck size={18} />}{selected.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}</button>
        <button className="button button--secondary" disabled={busy || !selected.isLocked} onClick={() => void mutate(`/api/admin/users/${selected.id}/unlock`, 'POST', { expectedVersion: selected.version })}><LockOpen size={18} /> فتح القفل</button>
        <div className="password-reset"><input aria-label="كلمة مرور مؤقتة جديدة" type="password" value={temporaryPassword} onChange={event => setTemporaryPassword(event.target.value)} placeholder="كلمة مرور مؤقتة جديدة" autoComplete="new-password" /><button className="button button--secondary" disabled={busy || !temporaryPassword} onClick={() => void mutate(`/api/admin/users/${selected.id}/reset-password`, 'POST', { expectedVersion: selected.version, temporaryPassword })}><KeyRound size={18} /> إعادة التعيين</button></div>
      </div></div>
    </section>}
  </div>
}

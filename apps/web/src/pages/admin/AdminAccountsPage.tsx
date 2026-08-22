import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Lock, Pencil, Unlock, UserPlus } from 'lucide-react'
import { adminApi, referenceApi } from '../../api/endpoints'
import { arabicErrorMessage } from '../../api/messages'
import type { AdminAccount, OperationalUnitView } from '../../api/admin-types'
import type { RoutingUnitOption } from '../../api/workflow-types'

function formatDateTime(value: string | null | undefined): string {
  return value ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value)) : '—'
}

/** One-time display of a temporary password; never persisted in component state beyond this render cycle. */
function TemporaryPasswordNotice({ password, onDismiss }: { password: string, onDismiss(): void }): React.JSX.Element {
  return (
    <div className="card card--soft temp-password" role="alert">
      <p><strong>كلمة المرور المؤقتة (تُعرض مرة واحدة فقط):</strong> <span className="mono">{password}</span></p>
      <p className="muted">انسخها الآن وشاركها مع المستخدم عبر قناة آمنة. سيُطلب منه تغييرها عند أول دخول.</p>
      <button type="button" className="button button--secondary" onClick={onDismiss}>تم النسخ — إخفاء</button>
    </div>
  )
}

export function AdminAccountsPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null)
  const [units, setUnits] = useState<OperationalUnitView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [resetTarget, setResetTarget] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [editTarget, setEditTarget] = useState<AdminAccount | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editJobTitle, setEditJobTitle] = useState('')

  // Create form
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [staffIdentifier, setStaffIdentifier] = useState('')
  const [accountType, setAccountType] = useState<'ADMIN' | 'OPERATIONAL'>('OPERATIONAL')
  const [unitId, setUnitId] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setAccounts(await adminApi.accounts())
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void reload()
    referenceApi.routingUnits().then().catch(() => {})
    adminApi.units().then(list => setUnits(list)).catch(() => {})
  }, [reload])

  async function act(id: string, action: () => Promise<unknown>, successMessage: string): Promise<void> {
    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(successMessage)
      await reload()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusyId(null)
    }
  }

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setCreateError(null)
    try {
      const created = await adminApi.createAccount({
        username: username.trim(),
        displayName: displayName.trim(),
        jobTitle: jobTitle.trim() || null,
        staffIdentifier: staffIdentifier.trim() || null,
        accountType,
        temporaryPassword: initialPassword,
        unitId: accountType === 'OPERATIONAL' ? unitId : null
      })
      setTempPassword(initialPassword)
      setShowCreate(false)
      setUsername(''); setDisplayName(''); setJobTitle(''); setStaffIdentifier(''); setInitialPassword(''); setUnitId('')
      setNotice(`تم إنشاء الحساب ${created.username}.`)
      await reload()
    } catch (requestError) {
      setCreateError(arabicErrorMessage(requestError))
    }
  }

  async function resetPassword(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!resetTarget || !newPassword) return
    const target = resetTarget
    await act(target, () => adminApi.resetTemporaryPassword(target, newPassword), 'تم إعادة تعيين كلمة المرور.')
    setTempPassword(newPassword)
    setResetTarget(null)
    setNewPassword('')
  }

  function beginEdit(account: AdminAccount): void {
    setEditTarget(account)
    setEditDisplayName(account.displayName)
    setEditJobTitle(account.jobTitle ?? '')
  }

  async function saveEdit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!editTarget) return
    const target = editTarget
    await act(target.id, () => adminApi.updateAccount(target.id, {
      staffIdentifier: target.staffIdentifier,
      displayName: editDisplayName.trim(),
      jobTitle: editJobTitle.trim() || null
    }), 'تم تحديث بيانات الحساب الحالية دون تغيير العضوية أو صلاحية المدير.')
    setEditTarget(null)
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>الحسابات</h1>
        <button type="button" className="button button--primary" onClick={() => setShowCreate(value => !value)}>
          <UserPlus size={17} aria-hidden="true" /> {showCreate ? 'إخفاء نموذج الإنشاء' : 'حساب جديد'}
        </button>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {tempPassword && <TemporaryPasswordNotice password={tempPassword} onDismiss={() => setTempPassword(null)} />}

      {showCreate && (
        <form className="card create-account" onSubmit={event => void create(event)} aria-label="إنشاء حساب">
          <h2>إنشاء حساب جديد</h2>
          {createError && <p className="error" role="alert">{createError}</p>}
          <div className="field-grid">
            <label className="field">اسم المستخدم
              <input type="text" value={username} onChange={e => setUsername(e.target.value)} maxLength={120} required minLength={3} />
            </label>
            <label className="field">الاسم الظاهر
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={240} required />
            </label>
            <label className="field">المسمى الوظيفي
              <input type="text" value={jobTitle} onChange={e => setJobTitle(e.target.value)} maxLength={240} />
            </label>
            <label className="field">المعرف الوظيفي (اختياري)
              <input type="text" value={staffIdentifier} onChange={e => setStaffIdentifier(e.target.value)} maxLength={120} />
            </label>
            <label className="field">نوع الحساب
              <select value={accountType} onChange={e => setAccountType(e.target.value as 'ADMIN' | 'OPERATIONAL')}>
                <option value="OPERATIONAL">تشغيلي — يشارك في مسار العمل</option>
                <option value="ADMIN">مدير نظام — إدارة النظام فقط</option>
              </select>
            </label>
            {accountType === 'OPERATIONAL' && (
              <label className="field">الوحدة التشغيلية الأولية
                <select value={unitId} onChange={e => setUnitId(e.target.value)} required>
                  <option value="" disabled>اختر الوحدة…</option>
                  {units.map(unit => (
                    <option key={unit.id} value={unit.id}>{unit.kind === 'HR' ? 'الموارد البشرية' : unit.kind === 'ORG' ? 'التنظيم' : 'السلطة المختصة'} — {unit.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">كلمة المرور المؤقتة
              <input type="password" value={initialPassword} onChange={e => setInitialPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
          </div>
          <button type="submit" className="button button--primary">إنشاء الحساب</button>
        </form>
      )}

      {resetTarget && (
        <form className="card card--soft" onSubmit={event => void resetPassword(event)} aria-label="إعادة تعيين كلمة المرور">
          <h3><KeyRound size={17} aria-hidden="true" /> كلمة مرور مؤقتة جديدة</h3>
          <label className="field">
            كلمة المرور المؤقتة
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
          </label>
          <div className="stage-actions__group">
            <button type="submit" className="button button--primary">تعيين</button>
            <button type="button" className="button button--secondary" onClick={() => { setResetTarget(null); setNewPassword('') }}>إلغاء</button>
          </div>
        </form>
      )}

      {editTarget && (
        <div className="password-dialog-backdrop" role="presentation">
          <section className="password-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-account-title">
            <div className="password-dialog__heading"><div><h2 id="edit-account-title">تعديل بيانات الحساب</h2><p>{editTarget.username} — تعديل الملف الحالي فقط</p></div></div>
            <form className="password-dialog__form" onSubmit={event => void saveEdit(event)}>
              <label><span>الاسم الظاهر</span><input type="text" value={editDisplayName} onChange={event => setEditDisplayName(event.target.value)} maxLength={240} required autoFocus /></label>
              <label><span>المسمى الوظيفي</span><input type="text" value={editJobTitle} onChange={event => setEditJobTitle(event.target.value)} maxLength={240} /></label>
              <p className="hint">لن يغيّر هذا الإجراء نوع الحساب أو عضوية الوحدة أو صلاحية المدير، ولن يعدّل بيانات التوقيعات التاريخية.</p>
              <div className="password-dialog__actions"><button type="button" className="button button--secondary" onClick={() => setEditTarget(null)}>إلغاء</button><button type="submit" className="button button--primary" disabled={!editDisplayName.trim() || busyId === editTarget.id}>حفظ التعديلات</button></div>
            </form>
          </section>
        </div>
      )}

      {accounts === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : (
        <section className="card" aria-label="قائمة الحسابات">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">المستخدم</th>
                  <th scope="col">النوع</th>
                  <th scope="col">الحالة</th>
                  <th scope="col">أُنشئ</th>
                  <th scope="col"><span className="sr-only">إجراءات</span></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(account => (
                  <tr key={account.id}>
                    <td><strong>{account.displayName}</strong><br /><small>{account.jobTitle ?? 'بدون مسمى وظيفي'}</small><br /><small className="mono">{account.username}</small></td>
                    <td>{account.accountType === 'ADMIN' ? 'مدير نظام — إدارة النظام فقط' : 'تشغيلي — يشارك في مسار العمل'}</td>
                    <td>
                      {!account.isActive ? <span className="badge badge--danger">معطل</span>
                        : account.lockedUntil && new Date(account.lockedUntil) > new Date() ? <span className="badge badge--warning">مقفل مؤقتاً</span>
                          : account.mustChangePassword ? <span className="badge badge--info">كلمة مرور مؤقتة</span>
                            : <span className="badge badge--success">نشط</span>}
                    </td>
                    <td>{formatDateTime(account.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="button button--secondary" disabled={busyId === account.id} onClick={() => beginEdit(account)}><Pencil size={15} aria-hidden="true" /> تعديل بيانات الحساب</button>
                        {account.isActive ? (
                          <button type="button" className="button button--danger" disabled={busyId === account.id}
                            onClick={() => void act(account.id, () => adminApi.disableAccount(account.id), 'تم تعطيل الحساب.')}>
                            تعطيل
                          </button>
                        ) : (
                          <button type="button" className="button button--primary" disabled={busyId === account.id}
                            onClick={() => void act(account.id, () => adminApi.enableAccount(account.id), 'تم تفعيل الحساب.')}>
                            تفعيل
                          </button>
                        )}
                        <button type="button" className="button button--secondary" disabled={busyId === account.id} title="فك القفل"
                          onClick={() => void act(account.id, () => adminApi.unlockAccount(account.id), 'تم فك القفل.')}>
                          <Unlock size={15} aria-hidden="true" /><Lock size={0} aria-hidden="true" /> فك القفل
                        </button>
                        <button type="button" className="button button--secondary" disabled={busyId === account.id}
                          onClick={() => setResetTarget(account.id)}>
                          كلمة مرور مؤقتة
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import { adminApi, referenceApi } from '../../api/endpoints'
import { arabicErrorMessage } from '../../api/messages'
import { UNIT_KIND_LABELS } from '../../api/types'
import type {
  ManagerHistoryEntry,
  OperationalUnitView,
  SubordinateMemberView,
  UnitMemberView
} from '../../api/admin-types'
import type { RoutingUnitOption } from '../../api/workflow-types'
import type { AdminAccount } from '../../api/admin-types'

function formatDateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value)) : '—'
}

function UnitDetail({ unitId }: { unitId: string }): React.JSX.Element {
  const [members, setMembers] = useState<UnitMemberView[] | null>(null)
  const [subordinates, setSubordinates] = useState<SubordinateMemberView[]>([])
  const [history, setHistory] = useState<ManagerHistoryEntry[] | null>(null)
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Transfer / manager forms
  const [transferUserId, setTransferUserId] = useState('')
  const [managerUserId, setManagerUserId] = useState('')
  const [replacementReason, setReplacementReason] = useState('')
  const [showManagerForm, setShowManagerForm] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [membersList, subordinatesList, managerHistory] = await Promise.all([
        adminApi.unitMembers(unitId),
        adminApi.subordinates(unitId).catch(() => [] as SubordinateMemberView[]),
        adminApi.managerHistory(unitId)
      ])
      setMembers(membersList)
      setSubordinates(subordinatesList)
      setHistory(managerHistory)
      const currentManagerId = membersList.find(member => member.managerAssignmentId)?.id ?? ''
      setManagerUserId(currentManagerId)
      setShowManagerForm(false)
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [unitId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    adminApi.accounts().then(list => setAccounts(list.filter(account => account.accountType === 'OPERATIONAL'))).catch(() => {})
  }, [])

  async function run(action: () => Promise<unknown>, successMessage: string): Promise<void> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(successMessage)
      await reload()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  const currentManager = (members ?? []).find(member => member.managerAssignmentId !== null) ?? null

  return (
    <section className="card unit-detail" aria-label="تفاصيل الوحدة">
      <h3>أعضاء الوحدة</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}

      <div className="manager-summary">
        <strong>المدير الحالي:</strong>{' '}
        {currentManager ? `${currentManager.displayName} (${currentManager.username})` : <em className="warning">لم يتم تعيين مدير</em>}
        <button type="button" className="button button--secondary" onClick={() => setShowManagerForm(value => !value)}>
          استبدال المدير
        </button>
      </div>

      {showManagerForm && (
        <form
          className="inline-form"
          onSubmit={event => {
            event.preventDefault()
            void run(
              () => adminApi.replaceManager(unitId, managerUserId, replacementReason.trim() || null),
              'تم تحديث تعيين المدير.'
            )
          }}
        >
          <label className="field">
            المدير الجديد (يجب أن يكون عضواً نشطاً في نفس الوحدة)
            <select value={managerUserId} onChange={event => setManagerUserId(event.target.value)} required>
              <option value="" disabled>اختر عضواً…</option>
              {(members ?? []).map(member => (
                <option key={member.id} value={member.id}>{member.displayName} ({member.username})</option>
              ))}
            </select>
          </label>
          <label className="field">
            سبب الاستبدال
            <input type="text" value={replacementReason} onChange={event => setReplacementReason(event.target.value)} maxLength={500} placeholder="مثال: إحالة للتقاعد" />
          </label>
          <div className="stage-actions__group">
            <button type="submit" className="button button--primary" disabled={busy || !managerUserId}>حفظ التعيين</button>
            <button type="button" className="button button--secondary" onClick={() => setShowManagerForm(false)}>إلغاء</button>
          </div>
        </form>
      )}

      {members === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : members.length === 0 ? (
        <p className="empty">لا يوجد أعضاء نشطون.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">العضو</th>
                <th scope="col">المسمى</th>
                <th scope="col">منذ</th>
                <th scope="col">الدور الإداري</th>
              </tr>
            </thead>
            <tbody>
              {members.map(member => (
                <tr key={member.membershipId}>
                  <td><strong>{member.displayName}</strong><br /><small className="mono">{member.username}</small></td>
                  <td>{member.jobTitle ?? '—'}</td>
                  <td>{formatDateTime(member.effectiveFrom)}</td>
                  <td>{member.managerAssignmentId ? 'مدير الوحدة' : 'موظف تابع'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>نقل عضوية مستخدم إلى هذه الوحدة</h3>
      <form
        className="inline-form"
        onSubmit={event => {
          event.preventDefault()
          if (!transferUserId) return
          void run(() => adminApi.transferMembership(unitId, transferUserId), 'تم نقل العضوية.')
          setTransferUserId('')
        }}
      >
        <label className="field">
          حساب تشغيلي نشط
          <select value={transferUserId} onChange={event => setTransferUserId(event.target.value)} required>
            <option value="" disabled>اختر الحساب…</option>
            {accounts.map(account => (
              <option key={account.id} value={account.id}>{account.displayName} ({account.username}){!account.isActive ? ' — معطل' : ''}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="button button--primary" disabled={busy || !transferUserId}>نقل العضوية</button>
        <p className="hint">يُسمح باشتراك تشغيلي نشط واحد فقط لكل حساب؛ النقل يُنهي أي عضوية سابقة تلقائياً.</p>
      </form>

      <details>
        <summary>المرؤوسون النشطون ({subordinates.length})</summary>
        <ul className="plain-list">
          {subordinates.map(subordinate => (
            <li key={subordinate.membershipId}>{subordinate.displayName} <span className="mono">({subordinate.username})</span></li>
          ))}
        </ul>
      </details>

      <details>
        <summary>سجل تعيين المديرين</summary>
        {history === null ? (
          <p className="muted">جارٍ التحميل…</p>
        ) : history.length === 0 ? (
          <p className="empty">لا يوجد سجل.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th scope="col">المدير</th><th scope="col">من</th><th scope="col">إلى</th><th scope="col">سبب الاستبدال</th></tr>
              </thead>
              <tbody>
                {history.map(entry => (
                  <tr key={entry.id}>
                    <td>{entry.displayName}</td>
                    <td>{formatDateTime(entry.effectiveFrom)}</td>
                    <td>{formatDateTime(entry.effectiveTo)}</td>
                    <td>{entry.replacementReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  )
}

export function AdminUnitsPage(): React.JSX.Element {
  const [units, setUnits] = useState<OperationalUnitView[] | null>(null)
  const [routingUnits, setRoutingUnits] = useState<RoutingUnitOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [kind, setKind] = useState<'HR' | 'ORG' | 'AUTH'>('ORG')
  const [name, setName] = useState('')
  const [routingUnitId, setRoutingUnitId] = useState('')

  const reload = useCallback(async () => {
    try {
      const list = await adminApi.units()
      setUnits(list)
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void reload()
    referenceApi.routingUnits()
      .then(list => setRoutingUnits(list.filter(unit => unit.isActive)))
      .catch(() => {})
  }, [reload])

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    try {
      await adminApi.createUnit({
        kind,
        name: name.trim(),
        routingUnitId: kind === 'AUTH' ? routingUnitId : null
      })
      setShowCreate(false)
      setName(''); setRoutingUnitId('')
      await reload()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>الوحدات التشغيلية</h1>
        <button type="button" className="button button--primary" onClick={() => setShowCreate(value => !value)}>
          <Building2 size={17} aria-hidden="true" /> {showCreate ? 'إخفاء الإنشاء' : 'وحدة جديدة'}
        </button>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      {showCreate && (
        <form className="card card--soft" onSubmit={event => void create(event)} aria-label="إنشاء وحدة تشغيلية">
          <div className="field-grid">
            <label className="field">النوع
              <select value={kind} onChange={event => setKind(event.target.value as 'HR' | 'ORG' | 'AUTH')}>
                <option value="HR">HR — الموارد البشرية</option>
                <option value="ORG">ORG — الشؤون التنظيمية</option>
                <option value="AUTH">AUTH — نيابة اعتماد</option>
              </select>
            </label>
            <label className="field">اسم الوحدة
              <input type="text" value={name} onChange={event => setName(event.target.value)} maxLength={240} required />
            </label>
            {kind === 'AUTH' && (
              <label className="field">نيابة التوجيه المرتبطة
                <select value={routingUnitId} onChange={event => setRoutingUnitId(event.target.value)} required>
                  <option value="" disabled>اختر النيابة…</option>
                  {routingUnits.map(unit => (
                    <option key={unit.id} value={unit.id}>{unit.nameAr} ({unit.code})</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button type="submit" className="button button--primary">إنشاء الوحدة</button>
        </form>
      )}

      {units === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : units.length === 0 ? (
        <p className="empty">لا توجد وحدات تشغيلية بعد.</p>
      ) : (
        <>
          <div className="tile-grid">
            {units.map(unit => (
              <button
                key={unit.id}
                type="button"
                className={`workspace-tile${selectedUnitId === unit.id ? ' workspace-tile--active' : ''}`}
                onClick={() => setSelectedUnitId(current => current === unit.id ? null : unit.id)}
                aria-pressed={selectedUnitId === unit.id}
              >
                <strong>{UNIT_KIND_LABELS[unit.kind]}</strong>
                <span>{unit.name}</span>
                <small>
                  {unit.routingUnitName ? `نيابة: ${unit.routingUnitName}` : 'عامة'}
                  {!unit.isActive ? ' • غير نشطة' : ''}
                </small>
              </button>
            ))}
          </div>
          {selectedUnitId && <UnitDetail unitId={selectedUnitId} />}
        </>
      )}
    </div>
  )
}

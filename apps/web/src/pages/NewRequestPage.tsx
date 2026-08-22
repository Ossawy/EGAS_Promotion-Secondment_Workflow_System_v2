import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { workflowApi, referenceApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { RoutingUnitOption, WorkflowRequestType } from '../api/workflow-types'

/** HR operational request creation: {requestType, routingUnitId} only — no legacy form-period fields. */
export function NewRequestPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [requestType, setRequestType] = useState<WorkflowRequestType>('PROMOTION')
  const [routingUnitId, setRoutingUnitId] = useState('')
  const [units, setUnits] = useState<RoutingUnitOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    referenceApi.routingUnits()
      .then(list => {
        if (!active) return
        const activeUnits = list.filter(unit => unit.isActive)
        setUnits(activeUnits)
        if (activeUnits.length === 1) setRoutingUnitId(activeUnits[0]!.id)
      })
      .catch(requestError => { if (active) setError(arabicErrorMessage(requestError)) })
    return () => { active = false }
  }, [])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || !routingUnitId) return
    setBusy(true)
    setError(null)
    try {
      const created = await workflowApi.createRequest({ requestType, routingUnitId })
      navigate(`/requests/${created.id}`)
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
      setBusy(false)
    }
  }

  const typeOptions = useMemo(() => ([
    { value: 'PROMOTION' as WorkflowRequestType, title: 'طلب ترقية', body: 'مسار الترقيات P1 → P2 → P3 → P4 → (P4O) → P5' },
    { value: 'SECONDMENT' as WorkflowRequestType, title: 'طلب ندب', body: 'مسار الندب S1 → S2 → S3 → S4 → S5' }
  ]), [])

  return (
    <div className="page-stack narrow">
      <header className="page-header">
        <h1>إنشاء طلب جديد</h1>
      </header>

      <form className="card" onSubmit={event => void submit(event)} aria-label="إنشاء طلب">
        {error && <p className="error" role="alert">{error}</p>}

        <fieldset className="type-picker">
          <legend>نوع الطلب</legend>
          {typeOptions.map(option => (
            <label key={option.value} className={`type-card${requestType === option.value ? ' type-card--selected' : ''}`}>
              <input
                type="radio"
                name="requestType"
                value={option.value}
                checked={requestType === option.value}
                onChange={() => setRequestType(option.value)}
              />
              <strong>{option.title}</strong>
              <small>{option.body}</small>
            </label>
          ))}
        </fieldset>

        <label className="field">
          النيابة / وحدة التوجيه
          <select value={routingUnitId} onChange={event => setRoutingUnitId(event.target.value)} required disabled={units === null}>
            <option value="" disabled>{units === null ? 'جارٍ التحميل…' : 'اختر النيابة…'}</option>
            {(units ?? []).map(unit => (
              <option key={unit.id} value={unit.id}>{unit.nameAr} ({unit.code})</option>
            ))}
          </select>
        </label>
        {units !== null && units.length === 0 && (
          <p className="warning">لا توجد نيابات نشطة. راجع إدارة النظام.</p>
        )}

        <button type="submit" className="button button--primary" disabled={busy || !routingUnitId}>
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء الطلب والانتقال للتحضير'}
        </button>
        <p className="hint">بعد الإنشاء ستنتقل إلى شاشة الطلب لإضافة المرشحين برقم الموظف من أحدث لقطة سنوية مفعّلة.</p>
      </form>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import {
  SIGNING_STAGE_CODES,
  STAGE_LABELS,
  type StageExecutionSummary
} from '../api/workflow-types'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { UserContext } from '../api/types'
import { SignAndAdvanceControl } from './SignAndAdvanceControl'

const INITIAL_STAGE_CODES = new Set(['P1', 'S1'])

function AssignPicker({
  stageId,
  suggestion,
  onAssigned,
  onError
}: {
  stageId: string
  suggestion: StageExecutionSummary | null
  onAssigned(): void
  onError(message: string): void
}): React.JSX.Element {
  const [options, setOptions] = useState<{ userId: string, displayName: string, jobTitle: string | null }[] | null>(null)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const loadOptions = useCallback(async () => {
    try {
      const list = await workflowApi.managerSubordinates()
      setOptions(list)
    } catch (requestError) {
      onError(arabicErrorMessage(requestError))
    }
  }, [onError])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  async function assign(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!selectedUserId || busy) return
    setBusy(true)
    try {
      await workflowApi.assignStage(stageId, selectedUserId, reason.trim() || null)
      setReason('')
      setSelectedUserId('')
      onAssigned()
    } catch (requestError) {
      onError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="assign-picker card card--soft" onSubmit={event => void assign(event)}>
      <label className="field">
        إسناد المرحلة إلى موظف
        <select
          value={selectedUserId}
          onChange={event => setSelectedUserId(event.target.value)}
          required
          disabled={busy}
        >
          <option value="" disabled>اختر موظفاً من وحدتك…</option>
          {(options ?? []).map(option => (
            <option key={option.userId} value={option.userId}>
              {option.displayName}{option.jobTitle ? ` — ${option.jobTitle}` : ''}
            </option>
          ))}
        </select>
        {options !== null && options.length === 0 && (
          <small className="muted">لا يوجد موظفون تابعون نشطون في وحدتك. يمكنك تنفيذ المرحلة بنفسك.</small>
        )}
      </label>
      {suggestion?.suggestedAssigneeDisplayName && (
        <p className="hint">
          اقتراح النظام (عامل سابق في هذه المرحلة): <strong>{suggestion.suggestedAssigneeDisplayName}</strong>
          {suggestion.suggestedAssigneeUserId && (
            <button
              type="button"
              className="button button--link"
              onClick={() => setSelectedUserId(suggestion.suggestedAssigneeUserId!)}
            >
              اختيار المقترح
            </button>
          )}
        </p>
      )}
      <label className="field">
        سبب الإسناد (اختياري)
        <input type="text" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy} />
      </label>
      <button type="submit" className="button button--primary" disabled={!selectedUserId || busy}>
        {busy ? 'جارٍ الإسناد…' : 'إسناد'}
      </button>
    </form>
  )
}

function ReasonAction({
  label,
  placeholder,
  busy,
  onConfirm,
}: {
  label: string
  placeholder: string
  busy: boolean
  onConfirm(reason: string): Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!reason.trim()) return
    try {
      await onConfirm(reason.trim())
      setReason('')
      setOpen(false)
    } catch {
      // Error surfaced by parent via reload/error state.
    }
  }

  if (!open) {
    return (
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }
  return (
    <form className="inline-reason" onSubmit={event => void submit(event)}>
      <label className="sr-only" htmlFor={`reason-${label}`}>{placeholder}</label>
      <input
        id={`reason-${label}`}
        type="text"
        value={reason}
        onChange={event => setReason(event.target.value)}
        placeholder={placeholder}
        maxLength={1000}
        required
        autoFocus
        disabled={busy}
      />
      <button type="submit" className="button button--primary" disabled={!reason.trim() || busy}>{label}</button>
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => { setOpen(false); setReason('') }}>إلغاء</button>
    </form>
  )
}

function CorrectionDialog({
  stage,
  managerUserId,
  busy,
  onConfirm,
  onError
}: {
  stage: StageExecutionSummary
  managerUserId: string
  busy: boolean
  onConfirm(input: { reason: string, assignedToUserId?: string, managerHandlesPersonally?: boolean }): Promise<void>
  onError(message: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'employee' | 'self'>(stage.activeAssigneeUserId === managerUserId ? 'self' : 'employee')
  const [selectedUserId, setSelectedUserId] = useState(stage.activeAssigneeUserId === managerUserId ? '' : (stage.activeAssigneeUserId ?? ''))
  const [options, setOptions] = useState<{ userId: string, displayName: string, jobTitle: string | null }[]>([])

  async function show(): Promise<void> {
    setOpen(true)
    try {
      const list = await workflowApi.managerSubordinates()
      setOptions(list)
      if (mode === 'employee' && !selectedUserId) setSelectedUserId(list[0]?.userId ?? '')
    } catch (requestError) {
      onError(arabicErrorMessage(requestError))
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!reason.trim() || (mode === 'employee' && !selectedUserId)) return
    try {
      await onConfirm(mode === 'self'
        ? { reason: reason.trim(), managerHandlesPersonally: true }
        : { reason: reason.trim(), assignedToUserId: selectedUserId })
      setReason('')
      setOpen(false)
    } catch {}
  }

  return <>
    <button type="button" className="button button--secondary" disabled={busy} onClick={() => void show()}>
      إعادة للموظف للتصحيح
    </button>
    {open && (
      <div className="password-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setOpen(false) }}>
        <section className="password-dialog" role="dialog" aria-modal="true" aria-labelledby="correction-dialog-title">
          <div className="password-dialog__heading">
            <div>
              <h2 id="correction-dialog-title">إعادة العمل للتصحيح</h2>
              <p>حدد المسؤول عن التصحيح. يبقى السبب محفوظاً في سجل المرحلة.</p>
            </div>
          </div>
          <form className="password-dialog__form" onSubmit={event => void submit(event)}>
            {stage.activeAssigneeDisplayName && (
              <p className="hint">الموظف الحالي والمقترح: <strong>{stage.activeAssigneeDisplayName}</strong></p>
            )}
            <label>
              <span>المسؤول عن التصحيح</span>
              <select value={mode === 'self' ? '__SELF__' : selectedUserId} onChange={event => {
                if (event.target.value === '__SELF__') setMode('self')
                else { setMode('employee'); setSelectedUserId(event.target.value) }
              }} disabled={busy} required>
                <option value="__SELF__">إجراء التعديل بنفسي</option>
                {options.map(option => <option key={option.userId} value={option.userId}>{option.displayName}{option.jobTitle ? ` — ${option.jobTitle}` : ''}</option>)}
              </select>
            </label>
            <label>
              <span>سبب التصحيح (مطلوب)</span>
              <textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} required autoFocus disabled={busy} />
            </label>
            <div className="password-dialog__actions">
              <button type="button" className="button button--secondary" disabled={busy} onClick={() => setOpen(false)}>إلغاء</button>
              <button type="submit" className="button button--primary" disabled={busy || !reason.trim() || (mode === 'employee' && !selectedUserId)}>تأكيد الإعادة للتصحيح</button>
            </div>
          </form>
        </section>
      </div>
    )}
  </>
}

export function StageActionsPanel({
  stage,
  user,
  onChanged
}: {
  stage: StageExecutionSummary | null
  user: UserContext
  onChanged(): void
}): React.JSX.Element | null {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const context = user.operationalContext
  const isManagerOfUnit = context !== null
    && context.isManager
    && stage !== null
    && context.unitId === stage.responsibleUnitId
  const isAssignee = user.userId === stage?.activeAssigneeUserId

  if (!stage || stage.status !== 'OPEN') return null

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  const requiresSignature = SIGNING_STAGE_CODES.has(stage.stageCode)
  const canReturnPrevious = !INITIAL_STAGE_CODES.has(stage.stageCode)
  const managerControlsVisible = isManagerOfUnit

  return (
    <section className="card stage-actions" aria-label="إجراءات المرحلة الحالية">
      <h2>إجراءات المرحلة</h2>
      <p className="muted">{STAGE_LABELS[stage.stageCode]} • حالة العمل: {stage.workState}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!managerControlsVisible && !isAssignee && (
        <p className="muted">لا تتوفر إجراءات مباشرة عليك في هذه المرحلة.</p>
      )}
      <div className="stage-actions__group">
        {managerControlsVisible && stage.workState === 'MANAGER_INBOX' && (
          <>
            <AssignPicker
              stageId={stage.id}
              suggestion={stage.suggestedAssigneeUserId ? stage : null}
              onAssigned={() => onChanged()}
              onError={setError}
            />
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void run(() => workflowApi.takeStage(stage.id))}
            >
              تنفيذ المرحلة بنفسي
            </button>
          </>
        )}

        {managerControlsVisible && (stage.workState === 'ASSIGNED' || stage.workState === 'IN_PROGRESS') && (
          <>
            <p className="muted">
              المسند إليه حالياً:
              {' '}
              {stage.activeAssigneeDisplayName
                ? <Link to={`/requests/${stage.requestId}`}><UserRound size={15} aria-hidden="true" /> {stage.activeAssigneeDisplayName}</Link>
                : '—'}
            </p>
            <details>
              <summary className="button button--secondary">إعادة إسناد</summary>
              <div className="details-body">
                <AssignPicker stageId={stage.id} suggestion={null} onAssigned={() => onChanged()} onError={setError} />
              </div>
            </details>
          </>
        )}

        {isAssignee && ['ASSIGNED', 'IN_PROGRESS', 'CORRECTION_REQUIRED'].includes(stage.workState) && (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void run(() => workflowApi.submitToManager(stage.id))}
          >
            رفع العمل إلى المدير
          </button>
        )}
        {isAssignee && stage.workState === 'CORRECTION_REQUIRED' && (
          <div className="correction-evidence" role="note">
            <strong>أُعيدت المرحلة إليك للتصحيح</strong>
            <p>{stage.correctionReason ?? 'راجع سجل المرحلة لمعرفة سبب التصحيح.'}</p>
            {stage.correctionRequestedByDisplayName && <small>بواسطة {stage.correctionRequestedByDisplayName}</small>}
          </div>
        )}

        {managerControlsVisible && stage.workState === 'MANAGER_REVIEW' && (
          <>
            {requiresSignature ? (
              <SignAndAdvanceControl
                stageId={stage.id}
                stageLabel={`${STAGE_LABELS[stage.stageCode]} — الطلب ${stage.requestNumber}`}
                onChanged={() => onChanged()}
                onError={setError}
              />
            ) : (
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void run(() => workflowApi.approveAndAdvance(stage.id))}
              >
                اعتماد والمتابعة للمرحلة التالية
              </button>
            )}
            <CorrectionDialog
              stage={stage}
              managerUserId={user.userId}
              busy={busy}
              onError={setError}
              onConfirm={input => run(() => workflowApi.internalCorrection(stage.id, input))}
            />
            {canReturnPrevious && (
              <ReasonAction
                label="إرجاع الطلب للمرحلة السابقة"
                placeholder="سبب الإرجاع إلى مدير المرحلة السابقة (مطلوب)"
                busy={busy}
                onConfirm={reason => run(() => workflowApi.returnPrevious(stage.id, reason))}
              />
            )}
            <ReasonAction
              label="رفض الطلب"
              placeholder="سبب الرفض (مطلوب)"
              busy={busy}
              onConfirm={reason => run(() => workflowApi.rejectStage(stage.id, reason))}
            />
          </>
        )}
      </div>
    </section>
  )
}

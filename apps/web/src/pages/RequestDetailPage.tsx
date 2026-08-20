import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Building2, CalendarDays, Check, ClipboardList, Clock3, FileText,
  MessageSquarePlus, Search, ShieldCheck, Trash2, UserRoundPlus, UsersRound
} from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, apiJson, apiRequest } from '../api/client'
import type {
  AuthorityOption, EmployeeSnapshotView, TimelineEntry, WorkflowNote, WorkflowRequestDetail
} from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { SecondmentWorkflowPanel } from '../components/SecondmentWorkflowPanel'
import { PromotionWorkflowPanel } from '../components/PromotionWorkflowPanel'
import { WorkflowControlsPanel } from '../components/WorkflowControlsPanel'
import { SignoffPanel } from '../components/SignoffPanel'
import { DocumentPanel } from '../components/DocumentPanel'

const actionLabels: Record<string, string> = {
  REQUEST_CREATED: 'إنشاء الطلب', STAGE_TASK_CREATED: 'فتح مهمة المرحلة',
  CANDIDATE_ADDED: 'إضافة عامل', CANDIDATE_REMOVED: 'إزالة عامل',
  AUTHORITY_SELECTED: 'اختيار سلطة الاعتماد', NOTE_ADDED: 'إضافة ملاحظة'
}

const roleLabels: Record<string, string> = {
  EMPLOYEE_AFFAIRS: 'شئون العاملين', ORGANIZATION: 'التنظيم', APPROVING_AUTHORITY: 'سلطة الاعتماد', ADMIN: 'إدارة النظام'
}

const errorLabels: Record<string, string> = {
  ACTIVE_SNAPSHOT_UNAVAILABLE: 'لا توجد لقطة سنوية نشطة حالياً.',
  EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT: 'رقم العامل غير موجود في اللقطة السنوية النشطة.',
  EMPLOYEE_ROUTING_UNRESOLVED: 'تعذر تحديد مسار العامل من البيانات السنوية.',
  WORKFLOW_ROUTING_MISMATCH: 'يجب أن ينتمي جميع العاملين في الطلب إلى وحدة مسار واحدة.',
  WORKFLOW_CANDIDATE_DUPLICATE: 'هذا العامل مضاف بالفعل إلى الطلب.',
  WORKFLOW_AUTHORITY_NOT_FOUND: 'تعيين سلطة الاعتماد لم يعد متاحاً لهذه الوحدة.'
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return errorLabels[error.code] ?? error.message
  return 'تعذر إتمام العملية. يرجى المحاولة مرة أخرى.'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function CandidateWarnings({ candidate }: { candidate: EmployeeSnapshotView | WorkflowRequestDetail['candidates'][number] }): React.JSX.Element | null {
  if (candidate.warnings.performanceMissing) return <span className="inline-warning"><AlertTriangle size={14} /> تقييم الأداء غير متاح</span>
  if (candidate.warnings.performanceRequiresAttention) return <span className="inline-warning"><AlertTriangle size={14} /> التقييم يحتاج مراجعة</span>
  return null
}

export function RequestDetailPage(): React.JSX.Element {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const [detail, setDetail] = useState<WorkflowRequestDetail | null>(null)
  const [notes, setNotes] = useState<WorkflowNote[]>([])
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [authorities, setAuthorities] = useState<AuthorityOption[]>([])
  const [personnelNumber, setPersonnelNumber] = useState('')
  const [employee, setEmployee] = useState<EmployeeSnapshotView | null>(null)
  const [noteMessage, setNoteMessage] = useState('')
  const [noteCandidateId, setNoteCandidateId] = useState('')
  const [selectedAuthority, setSelectedAuthority] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSupportingData = useCallback(async (): Promise<void> => {
    const [loadedNotes, loadedTimeline] = await Promise.all([
      apiRequest<WorkflowNote[]>(`/api/workflow/requests/${id}/notes?top=100`),
      apiRequest<TimelineEntry[]>(`/api/workflow/requests/${id}/timeline?top=100`)
    ])
    setNotes(loadedNotes)
    setTimeline(loadedTimeline)
  }, [id])

  const loadDetail = useCallback(async (): Promise<WorkflowRequestDetail> => {
    const loaded = await apiRequest<WorkflowRequestDetail>(`/api/workflow/requests/${id}`)
    setDetail(loaded)
    setSelectedAuthority(loaded.approvingAuthority?.assignmentId ?? '')
    return loaded
  }, [id])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([loadDetail(), loadSupportingData()])
      .catch(caught => { if (active) setError(errorMessage(caught)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadDetail, loadSupportingData])

  useEffect(() => {
    if (!detail?.editable || !detail.routingUnit || user?.operationalContext?.unitKind !== 'HR') {
      setAuthorities([])
      return
    }
    let active = true
    apiRequest<AuthorityOption[]>(`/api/workflow/requests/${id}/authority-options`)
      .then(options => { if (active) setAuthorities(options) })
      .catch(caught => { if (active) setError(errorMessage(caught)) })
    return () => { active = false }
  }, [detail?.editable, detail?.routingUnit, id, user?.operationalContext?.unitKind])

  const candidateNames = useMemo(() => new Map(detail?.candidates.map(item => [item.id, item.employeeName]) ?? []), [detail])

  async function lookupEmployee(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const value = personnelNumber.trim()
    if (!value) return
    setBusy('lookup')
    setError(null)
    setEmployee(null)
    try {
      setEmployee(await apiRequest<EmployeeSnapshotView>(`/api/employee-data/employees/${encodeURIComponent(value)}`))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  async function addEmployee(): Promise<void> {
    if (!employee) return
    setBusy('add')
    setError(null)
    try {
      const updated = await apiJson<WorkflowRequestDetail>(`/api/workflow/requests/${id}/candidates`, 'POST', { personnelNumber: employee.personnelNumber })
      setDetail(updated)
      setEmployee(null)
      setPersonnelNumber('')
      await loadSupportingData()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  async function removeCandidate(candidateId: string): Promise<void> {
    setBusy(`remove-${candidateId}`)
    setError(null)
    try {
      await apiRequest<void>(`/api/workflow/requests/${id}/candidates/${candidateId}`, { method: 'DELETE' })
      await Promise.all([loadDetail(), loadSupportingData()])
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  async function saveAuthority(): Promise<void> {
    if (!selectedAuthority) return
    setBusy('authority')
    setError(null)
    try {
      setDetail(await apiJson<WorkflowRequestDetail>(`/api/workflow/requests/${id}/authority`, 'PUT', { authorityAssignmentId: selectedAuthority }))
      await loadSupportingData()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  async function addNote(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!noteMessage.trim()) return
    setBusy('note')
    setError(null)
    try {
      const updated = await apiJson<WorkflowNote[]>(`/api/workflow/requests/${id}/notes`, 'POST', {
        candidateId: noteCandidateId || null, message: noteMessage
      })
      setNotes(updated)
      setNoteMessage('')
      await loadSupportingData()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="loading-panel"><span className="spinner" /> جارٍ تحميل الطلب...</div>
  if (!detail) return <div className="page-stack"><p className="error" role="alert">{error ?? 'تعذر العثور على الطلب.'}</p><Link className="button button--secondary" to="/">العودة للرئيسية</Link></div>

  return <div className="page-stack request-detail">
    <header className="page-heading request-heading">
      <div>
        <p>الطلبات / {detail.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</p>
        <h1>تفاصيل الطلب</h1>
        <span className="mono">{detail.requestNumber}</span>
      </div>
      <div className="heading-status"><StatusBadge status={detail.status} /><span>المرحلة {detail.currentStage} · الدورة {detail.currentIterationNo}</span></div>
    </header>

    {error && <p className="error" role="alert">{error}</p>}

    <section className="request-summary-grid">
      <article><CalendarDays /><span><small>الدورة / النموذج</small><strong>{detail.cycleYear} · {detail.formMonth}/{detail.formYear}</strong></span></article>
      <article><UsersRound /><span><small>عدد العاملين</small><strong>{detail.candidateCount}</strong></span></article>
      <article><Building2 /><span><small>وحدة المسار</small><strong>{detail.routingUnit?.nameAr ?? 'تتحدد بعد إضافة أول عامل'}</strong></span></article>
      <article><ShieldCheck /><span><small>سلطة الاعتماد</small><strong>{detail.approvingAuthority?.displayName ?? 'لم تُحدد'}</strong></span></article>
    </section>

    {detail.editable && <section className="panel">
      <div className="panel__header"><div><h2>إضافة عامل</h2><p>البحث مقيد برقم العامل داخل اللقطة السنوية النشطة.</p></div><UserRoundPlus size={23} /></div>
      <div className="workflow-panel-body">
        <form className="personnel-search" onSubmit={event => void lookupEmployee(event)}>
          <label htmlFor="personnel-number">رقم العامل</label>
          <div><input id="personnel-number" value={personnelNumber} onChange={event => setPersonnelNumber(event.target.value)} maxLength={120} placeholder="أدخل رقم العامل" required /><button className="button button--primary" disabled={busy === 'lookup'}><Search size={18} /> {busy === 'lookup' ? 'جارٍ البحث...' : 'بحث'}</button></div>
        </form>
        {employee && <article className="employee-preview">
          <div className="employee-preview__icon"><UsersRound /></div>
          <div><strong>{employee.employeeName}</strong><span>رقم العامل <b className="mono">{employee.personnelNumber}</b> · {employee.currentJobTitle ?? 'المسمى غير متاح'}</span><small>{employee.routingUnit.nameAr}{employee.subgroup ? ` · ${employee.subgroup}` : ''}</small><CandidateWarnings candidate={employee} /></div>
          <button className="button button--primary" type="button" disabled={busy === 'add'} onClick={() => void addEmployee()}><Check size={18} /> إضافة للطلب</button>
        </article>}
      </div>
    </section>}

    <section className="panel">
      <div className="panel__header"><div><h2>العاملون المرشحون</h2><p>بيانات محفوظة من اللقطة السنوية وقت الإضافة.</p></div><span className="panel-count">{detail.candidates.length}</span></div>
      {detail.candidates.length === 0 ? <EmptyState icon={UsersRound} title="لم يُضف أي عامل" body="ابحث برقم العامل لإضافته إلى المسودة وتحديد وحدة المسار." /> : <div className="table-scroll"><table className="data-table candidate-table">
        <thead><tr><th>العامل</th><th>الوظيفة الحالية</th><th>مجموعة فرعية</th><th>تقييم الأداء</th><th>المسار</th>{detail.editable && <th>إجراء</th>}</tr></thead>
        <tbody>{detail.candidates.map(candidate => <tr key={candidate.id}>
          <td><strong>{candidate.employeeName}</strong><small className="mono">{candidate.personnelNumber}</small></td>
          <td>{candidate.currentJobTitle ?? '—'}</td><td>{candidate.subgroup ?? '—'}</td>
          <td>{candidate.performanceRating ?? 'غير متاح'}<CandidateWarnings candidate={candidate} /></td>
          <td>{candidate.routingUnitName}</td>
          {detail.editable && <td><button className="danger-action" type="button" disabled={busy === `remove-${candidate.id}`} onClick={() => void removeCandidate(candidate.id)} aria-label={`إزالة ${candidate.employeeName}`}><Trash2 size={17} /> إزالة</button></td>}
        </tr>)}</tbody>
      </table></div>}
    </section>

    {detail.editable && detail.routingUnit && <section className="panel">
      <div className="panel__header"><div><h2>سلطة الاعتماد</h2><p>التعيينات النشطة والسارية لوحدة {detail.routingUnit.nameAr} فقط.</p></div><ShieldCheck size={23} /></div>
      {authorities.length === 0 ? <EmptyState icon={ShieldCheck} title="لا يوجد تعيين سلطة اعتماد" body="هذه حالة تشغيل صحيحة؛ يلزم أن يجهز مسؤول النظام تغطية الوحدة قبل إمكان استكمال الإرسال لاحقاً." /> : <div className="workflow-panel-body authority-options">
        {authorities.map(option => <label key={option.id} className={selectedAuthority === option.id ? 'authority-card authority-card--selected' : 'authority-card'}>
          <input type="radio" name="authority" checked={selectedAuthority === option.id} onChange={() => setSelectedAuthority(option.id)} />
          <span><strong>{option.displayName}</strong><small>{option.authorityJobTitle} · {option.authorityKind === 'PRIMARY' ? 'أساسي' : 'مفوّض'}{option.preferred ? ' · مفضل' : ''}</small></span>
          {selectedAuthority === option.id && <Check size={20} />}
        </label>)}
        <div className="form-actions form-actions--inline"><button type="button" className="button button--primary" disabled={!selectedAuthority || busy === 'authority'} onClick={() => void saveAuthority()}>{busy === 'authority' ? 'جارٍ الحفظ...' : 'حفظ سلطة الاعتماد'}</button></div>
      </div>}
    </section>}

    <SignoffPanel detail={detail} onChanged={loadSupportingData} />
    <DocumentPanel detail={detail} />
    {detail.requestType === 'SECONDMENT' && <SecondmentWorkflowPanel detail={detail} />}
    {detail.requestType === 'PROMOTION' && <PromotionWorkflowPanel detail={detail} />}
    <WorkflowControlsPanel detail={detail} />

    <div className="detail-columns">
      <section className="panel">
        <div className="panel__header"><div><h2>الملاحظات</h2><p>سجل إضافي لا يقبل التعديل أو الحذف.</p></div><MessageSquarePlus size={22} /></div>
        <form className="note-form" onSubmit={event => void addNote(event)}>
          <label>نطاق الملاحظة<select value={noteCandidateId} onChange={event => setNoteCandidateId(event.target.value)}><option value="">الطلب بالكامل</option>{detail.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.employeeName}</option>)}</select></label>
          <label>نص الملاحظة<textarea value={noteMessage} onChange={event => setNoteMessage(event.target.value)} maxLength={2000} rows={3} required placeholder="اكتب ملاحظة واضحة..." /></label>
          <button className="button button--primary" disabled={busy === 'note'}>{busy === 'note' ? 'جارٍ الإضافة...' : 'إضافة الملاحظة'}</button>
        </form>
        <div className="compact-feed">{notes.length === 0 ? <p className="feed-empty">لا توجد ملاحظات حتى الآن.</p> : notes.map(note => <article key={note.id}><span className="feed-icon"><FileText size={17} /></span><div><strong>{note.authorName}</strong><small>{roleLabels[note.authorRole] ?? note.authorRole} · {note.stageCode ?? '—'}{note.candidateId ? ` · ${candidateNames.get(note.candidateId) ?? 'عامل'}` : ''}</small><p>{note.message}</p><time>{formatDate(note.createdAt)}</time></div></article>)}</div>
      </section>

      <section className="panel">
        <div className="panel__header"><div><h2>الخط الزمني</h2><p>الأحداث مرتبة زمنياً ومحفوظة كأدلة.</p></div><Clock3 size={22} /></div>
        <div className="timeline-feed">{timeline.length === 0 ? <p className="feed-empty">لا توجد أحداث.</p> : timeline.map(entry => <article key={`${entry.kind}-${entry.id}`}><span className="timeline-feed__line" /><span className="feed-icon"><ClipboardList size={17} /></span><div><strong>{entry.kind === 'NOTE' ? 'ملاحظة' : (actionLabels[entry.code] ?? entry.code)}</strong><small>{entry.actorName} · {roleLabels[entry.actorRole] ?? entry.actorRole}{entry.stageCode ? ` · ${entry.stageCode}` : ''}</small>{entry.message && <p>{entry.message}</p>}<time>{formatDate(entry.createdAt)}</time></div></article>)}</div>
      </section>
    </div>
  </div>
}

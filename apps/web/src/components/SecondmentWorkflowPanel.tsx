import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, Send, ShieldCheck, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, apiJson, apiRequest } from '../api/client'
import type { SecondmentPosition, WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { EmptyState } from './EmptyState'

const actionByStage: Record<string, { path: string, label: string }> = {
  S1: { path: 'submit-s1', label: 'توقيع وإرسال إلى التنظيم' },
  S2: { path: 'submit-s2', label: 'توقيع وإرسال إلى سلطة الاعتماد' },
  S3: { path: 'approve-s3', label: 'اعتماد الاختيارات وإرسالها للتنظيم' },
  S4: { path: 'confirm-s4', label: 'تأكيد اختيار السلطة وإرسال المراجعة النهائية' },
  S5: { path: 'final-approve-s5', label: 'الاعتماد النهائي' }
}

const errorLabels: Record<string, string> = {
  WORKFLOW_SIGNOFF_REQUIRED: 'يلزم استكمال التوقيع الإلزامي لهذه المرحلة قبل الإرسال.',
  WORKFLOW_POSITIONS_INCOMPLETE: 'يلزم إدخال وظيفة مقترحة كاملة واحدة على الأقل لكل عامل.',
  WORKFLOW_SELECTION_INCOMPLETE: 'يجب اختيار وظيفة مقترحة واحدة بالضبط لكل عامل.',
  WORKFLOW_TASK_NOT_FOUND: 'هذه المرحلة ليست مسندة إلى حسابك ضمن الدور النشط.',
  WORKFLOW_TASK_CONFLICT: 'سبق تنفيذ هذه العملية. حدّث الطلب لمشاهدة حالته الجديدة.'
}

function message(error: unknown): string {
  return error instanceof ApiError ? (errorLabels[error.code] ?? error.message) : 'تعذر إتمام العملية.'
}

export function SecondmentWorkflowPanel({ detail }: { detail: WorkflowRequestDetail }): React.JSX.Element {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [positions, setPositions] = useState<SecondmentPosition[]>([])
  const [categories, setCategories] = useState<Array<{ code: string, nameAr: string, isActive: boolean }>>([])
  const [candidateCategories, setCandidateCategories] = useState<Record<string, string>>(
    Object.fromEntries(detail.candidates.map(candidate => [candidate.id, candidate.formSection?.jobCategoryCode ?? '']))
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const role = user?.activeRole
  const actionable = detail.actionable && (
    (detail.currentStage === 'S1' && role === 'EMPLOYEE_AFFAIRS') ||
    (detail.currentStage === 'S2' && role === 'ORGANIZATION') ||
    (detail.currentStage === 'S3' && role === 'APPROVING_AUTHORITY') ||
    (detail.currentStage === 'S4' && role === 'ORGANIZATION') ||
    (detail.currentStage === 'S5' && role === 'EMPLOYEE_AFFAIRS')
  )

  async function load(): Promise<void> {
    try { setPositions(await apiRequest<SecondmentPosition[]>(`/api/workflow/requests/${detail.id}/secondment/positions`)) }
    catch (caught) { setError(message(caught)) }
  }
  useEffect(() => { void load() }, [detail.id, detail.currentStage])
  useEffect(() => {
    apiRequest<Array<{ code: string, nameAr: string, isActive: boolean }>>('/api/reference/job-categories')
      .then(setCategories).catch(() => setCategories([]))
  }, [])
  const byCandidate = useMemo(() => new Map(detail.candidates.map(candidate => [candidate.id, positions.filter(item => item.candidateId === candidate.id)])), [detail.candidates, positions])

  async function addPosition(event: React.FormEvent<HTMLFormElement>, candidateId: string): Promise<void> {
    event.preventDefault(); setBusy(`add-${candidateId}`); setError(null)
    const form = event.currentTarget; const data = new FormData(form)
    try {
      setPositions(await apiJson(`/api/workflow/requests/${detail.id}/secondment/candidates/${candidateId}/positions`, 'POST', {
        positionTitle: data.get('positionTitle'), organizationalDependency: data.get('organizationalDependency'),
        qualificationStatus: data.get('qualificationStatus')
      })); form.reset()
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function removePosition(positionId: string): Promise<void> {
    setBusy(positionId); setError(null)
    try { await apiRequest(`/api/workflow/requests/${detail.id}/secondment/positions/${positionId}`, { method: 'DELETE' }); await load() }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function setCategory(candidateId: string, jobCategoryCode: string): Promise<void> {
    if (!jobCategoryCode) return
    setBusy(`category-${candidateId}`); setError(null)
    try {
      await apiJson(`/api/workflow/requests/${detail.id}/secondment/candidates/${candidateId}/category`, 'PUT', { jobCategoryCode })
      setCandidateCategories(current => ({ ...current, [candidateId]: jobCategoryCode }))
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function select(candidateId: string, positionId: string): Promise<void> {
    setBusy(positionId); setError(null)
    try { setPositions(await apiJson(`/api/workflow/requests/${detail.id}/secondment/candidates/${candidateId}/selection`, 'PUT', { positionId })) }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function advance(): Promise<void> {
    const action = actionByStage[detail.currentStage]
    if (!action) return
    setBusy('advance'); setError(null)
    try { await apiJson(`/api/workflow/requests/${detail.id}/secondment/${action.path}`, 'POST', {}); navigate('/', { replace: true }) }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  return <section className="panel secondment-panel">
    <div className="panel__header"><div><h2>نموذج الندب · المرحلة {detail.currentStage}</h2><p>الوظائف المقترحة والاختيار محفوظة داخل الدورة {detail.currentIterationNo}.</p></div><ShieldCheck /></div>
    {error && <p className="error workflow-error" role="alert">{error}</p>}
    {detail.candidates.length === 0 ? <EmptyState icon={ShieldCheck} title="لا يوجد مرشحون" body="لا يمكن إعداد وظائف الندب قبل إضافة العاملين في S1." /> : <div className="candidate-position-list">{detail.candidates.map(candidate => {
      const options = byCandidate.get(candidate.id) ?? []
      return <article className="candidate-position" key={candidate.id}>
        <header><div><strong>{candidate.employeeName}</strong><small>{candidate.personnelNumber} · {candidate.currentJobTitle ?? '—'}</small></div><span>{options.length} وظيفة مقترحة</span></header>
        {detail.currentStage === 'S2' && actionable && <div className="candidate-category"><label>القسم / الفئة الوظيفية<select value={candidateCategories[candidate.id] ?? ''} disabled={busy !== null} onChange={event => void setCategory(candidate.id, event.target.value)}><option value="">اختر الفئة المعتمدة</option>{categories.filter(item => item.isActive).map(item => <option key={item.code} value={item.code}>{item.nameAr}</option>)}</select></label>{busy === `category-${candidate.id}` && <span>جارٍ الحفظ...</span>}</div>}
        {detail.currentStage !== 'S2' && candidate.formSection && <div className="candidate-category candidate-category--readonly"><span>الفئة الوظيفية: <strong>{candidate.formSection.nameAr}</strong></span></div>}
        {options.length > 0 && <div className="position-options">{options.map(option => <label key={option.id} className={option.isSelected ? 'position-option position-option--selected' : 'position-option'}>
          {detail.currentStage === 'S3' && actionable && <input type="radio" name={`candidate-${candidate.id}`} checked={option.isSelected} disabled={busy !== null} onChange={() => void select(candidate.id, option.id)} />}
          <span><strong>{option.positionTitle}</strong><small>{option.organizationalDependency} · {option.qualificationStatus === 'QUALIFIED' ? 'مستوفي' : 'غير مستوفي'}</small></span>
          {option.isSelected && <span className="selected-mark"><Check size={15} /> اختيار السلطة</span>}
          {detail.currentStage === 'S2' && actionable && <button type="button" className="danger-action" disabled={busy === option.id} onClick={() => void removePosition(option.id)}><Trash2 size={15} /> إزالة</button>}
        </label>)}</div>}
        {detail.currentStage === 'S2' && actionable && <form className="position-form" onSubmit={event => void addPosition(event, candidate.id)}>
          <label>الوظيفة الشاغرة / المقترحة<input name="positionTitle" required maxLength={500} /></label>
          <label>التبعية التنظيمية<input name="organizationalDependency" required maxLength={1000} /></label>
          <label>مدى استيفاء التأهيل<select name="qualificationStatus" required><option value="QUALIFIED">مستوفي</option><option value="NOT_QUALIFIED">غير مستوفي</option></select></label>
          <button className="button button--secondary" disabled={busy === `add-${candidate.id}`}><Plus size={16} /> إضافة وظيفة</button>
        </form>}
      </article>
    })}</div>}
    {actionable && actionByStage[detail.currentStage] && <footer className="form-actions secondment-actions">
      {(detail.currentStage === 'S1' || detail.currentStage === 'S2') && <span>يتحقق الخادم من وجود التوقيع الإلزامي قبل الانتقال.</span>}
      <button className="button button--primary" disabled={busy !== null} onClick={() => void advance()}>{detail.currentStage === 'S5' ? <Check size={18} /> : <Send size={18} />}{busy === 'advance' ? 'جارٍ التنفيذ...' : actionByStage[detail.currentStage]!.label}</button>
    </footer>}
  </section>
}

import { useEffect, useMemo, useState } from 'react'
import { Check, Save, Send, ShieldCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, apiJson, apiRequest } from '../api/client'
import type { PromotionDecision, WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { EmptyState } from './EmptyState'

const actions: Record<string, { path: string, label: string }> = {
  P1: { path: 'submit-p1', label: 'توقيع وإرسال إلى التنظيم' },
  P2: { path: 'submit-p2', label: 'توقيع وإرسال إلى مراجعة شئون العاملين' },
  P3: { path: 'approve-p3', label: 'اعتماد المراجعة وإرسال إلى سلطة الاعتماد' },
  P4: { path: 'approve-p4', label: 'اعتماد قرارات الترقية' },
  P4O: { path: 'confirm-p4o', label: 'تأكيد التنظيم وإرسال للاعتماد النهائي' },
  P5: { path: 'final-approve-p5', label: 'الاعتماد النهائي' }
}

const errorLabels: Record<string, string> = {
  WORKFLOW_SIGNOFF_REQUIRED: 'يلزم استكمال التوقيع الإلزامي لهذه المرحلة قبل الإرسال.',
  WORKFLOW_PREPARATION_INCOMPLETE: 'يلزم اختيار الفئة الوظيفية المعتمدة لكل عامل.',
  WORKFLOW_DECISION_INCOMPLETE: 'يلزم تسجيل قرار ترقية لكل عامل.',
  WORKFLOW_TARGET_ROUTING_INVALID: 'وحدة المسار المستهدفة غير نشطة أو غير موجودة.',
  WORKFLOW_TASK_CONFLICT: 'سبق تنفيذ العملية أو تغيرت المرحلة. حدّث الطلب.'
}
function message(error: unknown): string { return error instanceof ApiError ? (errorLabels[error.code] ?? error.message) : 'تعذر إتمام العملية.' }

export function PromotionWorkflowPanel({ detail }: { detail: WorkflowRequestDetail }): React.JSX.Element {
  const { user } = useAuth(); const navigate = useNavigate()
  const [decisions, setDecisions] = useState<PromotionDecision[]>([])
  const [categories, setCategories] = useState<Array<{ code: string, nameAr: string, isActive: boolean }>>([])
  const [routingUnits, setRoutingUnits] = useState<Array<{ id: string, nameAr: string, isActive: boolean }>>([])
  const [decisionTypes, setDecisionTypes] = useState<Record<string, 'SAME_POSITION' | 'OTHER_POSITION'>>({})
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null)
  const role = useMemo(() => {
    if (user?.accountType === 'ADMIN') return 'ADMIN'
    if (user?.operationalContext?.unitKind === 'HR') return 'EMPLOYEE_AFFAIRS'
    if (user?.operationalContext?.unitKind === 'ORG') return 'ORGANIZATION'
    if (user?.operationalContext?.isManager && user?.operationalContext?.unitKind === 'AUTH') return 'APPROVING_AUTHORITY'
    return null
  }, [user])
  const actionable = detail.actionable && (
    (detail.currentStage === 'P1' && role === 'EMPLOYEE_AFFAIRS') || (detail.currentStage === 'P2' && role === 'ORGANIZATION') ||
    (detail.currentStage === 'P3' && role === 'EMPLOYEE_AFFAIRS') || (detail.currentStage === 'P4' && role === 'APPROVING_AUTHORITY') ||
    (detail.currentStage === 'P4O' && role === 'ORGANIZATION') ||
    (detail.currentStage === 'P5' && role === 'EMPLOYEE_AFFAIRS'))

  useEffect(() => {
    Promise.all([
      apiRequest<PromotionDecision[]>(`/api/workflow/requests/${detail.id}/promotion/decisions`),
      apiRequest<Array<{ code: string, nameAr: string, isActive: boolean }>>('/api/reference/job-categories'),
      apiRequest<Array<{ id: string, nameAr: string, isActive: boolean }>>('/api/reference/routing-units')
    ]).then(([loadedDecisions, loadedCategories, loadedRoutingUnits]) => {
      setDecisions(loadedDecisions)
      setCategories(loadedCategories)
      setRoutingUnits(loadedRoutingUnits)
      setDecisionTypes(Object.fromEntries(loadedDecisions.map(item => [item.candidateId, item.decisionType])))
    })
      .catch(caught => setError(message(caught)))
  }, [detail.id, detail.currentStage])
  const decisionByCandidate = useMemo(() => new Map(decisions.map(item => [item.candidateId, item])), [decisions])

  function selectedDecisionType(candidateId: string): 'SAME_POSITION' | 'OTHER_POSITION' {
    return decisionTypes[candidateId] ?? decisionByCandidate.get(candidateId)?.decisionType ?? 'SAME_POSITION'
  }

  async function prepare(event: React.FormEvent<HTMLFormElement>, candidateId: string): Promise<void> {
    event.preventDefault(); setBusy(candidateId); setError(null)
    const data = new FormData(event.currentTarget)
    try {
      await apiJson(`/api/workflow/requests/${detail.id}/promotion/candidates/${candidateId}/preparation`, 'PUT', {
        jobCategoryCode: data.get('jobCategoryCode'), lastPromotionReport: data.get('lastPromotionReport') || null
      })
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function decide(event: React.FormEvent<HTMLFormElement>, candidateId: string): Promise<void> {
    event.preventDefault(); setBusy(candidateId); setError(null)
    const data = new FormData(event.currentTarget)
    const decisionType = data.get('decisionType')
    try {
      setDecisions(await apiJson<PromotionDecision[]>(`/api/workflow/requests/${detail.id}/promotion/candidates/${candidateId}/decision`, 'PUT', {
        decisionType,
        targetJobTitle: decisionType === 'OTHER_POSITION' ? (data.get('targetJobTitle') || null) : null,
        targetRoutingUnitId: decisionType === 'OTHER_POSITION' ? (data.get('targetRoutingUnitId') || null) : null,
        notes: data.get('notes') || null
      }))
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  async function advance(): Promise<void> {
    const action = actions[detail.currentStage]; if (!action) return
    setBusy('advance'); setError(null)
    try { await apiJson(`/api/workflow/requests/${detail.id}/promotion/${action.path}`, 'POST', {}); navigate('/', { replace: true }) }
    catch (caught) { setError(message(caught)) }
    finally { setBusy(null) }
  }

  return <section className="panel promotion-panel">
    <div className="panel__header"><div><h2>نموذج الترقية · المرحلة {detail.currentStage}</h2><p>تجهيز النموذج منفصل عن قرار نفس/وظيفة أخرى الخاص بسلطة الاعتماد.</p></div><ShieldCheck /></div>
    {error && <p className="error workflow-error" role="alert">{error}</p>}
    {detail.candidates.length === 0 ? <EmptyState icon={ShieldCheck} title="لا يوجد مرشحون" body="أضف العاملين في P1 قبل استكمال مسار الترقية." /> : <div className="promotion-candidate-list">{detail.candidates.map(candidate => {
      const decision = decisionByCandidate.get(candidate.id)
      return <article key={candidate.id} className="promotion-candidate">
        <header><div><strong>{candidate.employeeName}</strong><small>{candidate.personnelNumber} · {candidate.currentJobTitle ?? '—'}</small></div>{decision && <span className="selected-mark"><Check size={15} /> {decision.decisionType === 'SAME_POSITION' ? 'نفس الوظيفة' : 'وظيفة أخرى'}</span>}</header>
        {detail.currentStage === 'P2' && actionable ? <form className="promotion-form" onSubmit={event => void prepare(event, candidate.id)}>
          <label>الفئة الوظيفية<select name="jobCategoryCode" required defaultValue={candidate.formSection?.jobCategoryCode ?? ''}><option value="">اختر الفئة المعتمدة</option>{categories.filter(item => item.isActive).map(item => <option key={item.code} value={item.code}>{item.nameAr}</option>)}</select></label>
          <label>تقرير آخر ترقية (يدوي/اختياري)<input name="lastPromotionReport" maxLength={1000} defaultValue={candidate.lastPromotionReport ?? ''} /></label>
          <button className="button button--secondary" disabled={busy === candidate.id}><Save size={16} /> حفظ التجهيز</button>
        </form> : <div className="promotion-preparation"><span>الفئة: <strong>{candidate.formSection?.nameAr ?? 'لم تُحدد'}</strong></span><span>تقرير آخر ترقية: <strong>{candidate.lastPromotionReport ?? 'غير مدخل'}</strong></span></div>}
        {detail.currentStage === 'P4' && actionable ? <form className="promotion-form promotion-form--decision" onSubmit={event => void decide(event, candidate.id)}>
          <label>قرار الترقية<select name="decisionType" required value={selectedDecisionType(candidate.id)} onChange={event => setDecisionTypes(current => ({ ...current, [candidate.id]: event.target.value as 'SAME_POSITION' | 'OTHER_POSITION' }))}><option value="SAME_POSITION">الترقية على نفس الوظيفة</option><option value="OTHER_POSITION">الترقية على وظيفة أخرى</option></select></label>
          {selectedDecisionType(candidate.id) === 'OTHER_POSITION' && <>
            <label>الوظيفة المستهدفة<input name="targetJobTitle" maxLength={500} defaultValue={decision?.targetJobTitle ?? ''} required /></label>
            <label>وحدة المسار المستهدفة<select name="targetRoutingUnitId" defaultValue={decision?.targetRoutingUnitId ?? ''} required><option value="">اختر وحدة المسار المستهدفة</option>{routingUnits.filter(item => item.isActive).map(item => <option key={item.id} value={item.id}>{item.nameAr}</option>)}</select></label>
          </>}
          <label>ملاحظات القرار<input name="notes" maxLength={2000} defaultValue={decision?.notes ?? ''} /></label>
          <button className="button button--secondary" disabled={busy === candidate.id}><Save size={16} /> حفظ القرار</button>
        </form> : decision && <div className="promotion-decision-view"><strong>{decision.decisionType === 'SAME_POSITION' ? 'الترقية على نفس الوظيفة' : `الترقية على وظيفة أخرى: ${decision.targetJobTitle}`}</strong>{decision.decisionType === 'OTHER_POSITION' && <span>وحدة المسار المستهدفة: {decision.targetRoutingUnitName ?? '—'}</span>}{decision.notes && <span>{decision.notes}</span>}</div>}
      </article>
    })}</div>}
    {actionable && actions[detail.currentStage] && <footer className="form-actions secondment-actions">{(detail.currentStage === 'P1' || detail.currentStage === 'P2') && <span>يتحقق الخادم من التوقيع الإلزامي قبل الانتقال.</span>}<button className="button button--primary" disabled={busy !== null} onClick={() => void advance()}>{detail.currentStage === 'P5' ? <Check size={18} /> : <Send size={18} />}{busy === 'advance' ? 'جارٍ التنفيذ...' : actions[detail.currentStage]!.label}</button></footer>}
  </section>
}

import { useState } from 'react'
import { Ban, CornerUpRight, RotateCcw, Undo2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, apiJson } from '../api/client'
import type { WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'

type Control = 'return-for-correction'|'reject'|'restart'|'cancel-returned'|'recall'
const labels: Record<Control, string> = {
  'return-for-correction': 'إرجاع للتصحيح', reject: 'رفض الطلب', restart: 'بدء دورة جديدة',
  'cancel-returned': 'إلغاء الطلب', recall: 'استدعاء الطلب'
}

function message(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return 'تعذر تنفيذ الإجراء. حدّث الطلب وحاول مجدداً.'
}

export function WorkflowControlsPanel({ detail }: { detail: WorkflowRequestDetail }): React.JSX.Element | null {
  const { user } = useAuth(); const navigate = useNavigate()
  const [selected, setSelected] = useState<Control | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isOriginator = user?.activeRole === 'EMPLOYEE_AFFAIRS' && user.userId === detail.createdBy.id
  const canReturn = detail.status === 'IN_PROGRESS' && detail.actionable && ['P2','P3','P4','P4O','S2','S3','S4'].includes(detail.currentStage)
  const canReject = detail.status === 'IN_PROGRESS' && detail.actionable && ['P2','P3','P4','S2','S3','S4'].includes(detail.currentStage)
  const canRecall = isOriginator && ['DRAFT','IN_PROGRESS'].includes(detail.status)
  const returned = isOriginator && detail.status === 'RETURNED'
  if (!canReturn && !canReject && !canRecall && !returned) return null

  function choose(control: Control): void { setSelected(control); setReason(''); setError(null) }
  async function execute(event: React.FormEvent): Promise<void> {
    event.preventDefault(); if (!selected) return
    if (['return-for-correction','reject','recall'].includes(selected) && !reason.trim()) {
      setError('سبب الإجراء إلزامي.'); return
    }
    setBusy(true); setError(null)
    try {
      await apiJson(`/api/workflow/requests/${detail.id}/${selected}`, 'POST', { reason: reason.trim() || null })
      navigate('/', { replace: true })
    } catch (caught) { setError(message(caught)) }
    finally { setBusy(false) }
  }

  return <section className="panel workflow-controls">
    <div className="panel__header"><div><h2>إجراءات مسار الطلب</h2><p>كل رجوع أو رفض أو استدعاء يحفظ السبب والدورة السابقة كاملة.</p></div><Undo2 /></div>
    <div className="workflow-control-buttons">
      {canReturn && <button type="button" className="button button--secondary" onClick={() => choose('return-for-correction')}><CornerUpRight size={17} /> إرجاع للتصحيح</button>}
      {canReject && <button type="button" className="button button--danger" onClick={() => choose('reject')}><Ban size={17} /> رفض</button>}
      {canRecall && <button type="button" className="button button--secondary" onClick={() => choose('recall')}><Undo2 size={17} /> استدعاء وبدء دورة جديدة</button>}
      {returned && <><button type="button" className="button button--primary" onClick={() => choose('restart')}><RotateCcw size={17} /> إعادة البدء</button><button type="button" className="button button--danger" onClick={() => choose('cancel-returned')}><Ban size={17} /> إلغاء نهائي</button></>}
    </div>
    {selected && <form className="workflow-control-form" onSubmit={event => void execute(event)}>
      <label>سبب: {labels[selected]}<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} rows={3} required={['return-for-correction','reject','recall'].includes(selected)} placeholder="اكتب سبباً واضحاً يظهر لشئون العاملين وفي السجل..." /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div><button type="button" className="button button--secondary" onClick={() => setSelected(null)}>تراجع</button><button className={selected === 'reject' || selected === 'cancel-returned' ? 'button button--danger' : 'button button--primary'} disabled={busy}>{busy ? 'جارٍ التنفيذ...' : `تأكيد ${labels[selected]}`}</button></div>
    </form>}
  </section>
}

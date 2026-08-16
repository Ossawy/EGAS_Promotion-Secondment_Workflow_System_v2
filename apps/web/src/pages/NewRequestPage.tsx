import { useState } from 'react'
import { ArrowLeft, BriefcaseBusiness, CalendarDays, FilePlus2, UsersRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, apiJson } from '../api/client'
import type { WorkflowRequestDetail } from '../api/workflow-types'

type RequestType = 'PROMOTION' | 'SECONDMENT'

function message(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return 'تعذر إنشاء الطلب. يرجى المحاولة مرة أخرى.'
}

export function NewRequestPage(): React.JSX.Element {
  const navigate = useNavigate()
  const now = new Date()
  const [requestType, setRequestType] = useState<RequestType>('PROMOTION')
  const [cycleYear, setCycleYear] = useState(now.getFullYear())
  const [formMonth, setFormMonth] = useState(now.getMonth() + 1)
  const [formYear, setFormYear] = useState(now.getFullYear())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const created = await apiJson<WorkflowRequestDetail>('/api/workflow/requests', 'POST', {
        requestType, cycleYear, formMonth, formYear
      })
      navigate(`/requests/${created.id}`, { replace: true })
    } catch (caught) {
      setError(message(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return <div className="page-stack request-create-page">
    <header className="page-heading">
      <div>
        <p>الطلبات / طلب جديد</p>
        <h1>إنشاء طلب ترقية أو ندب</h1>
        <span>ابدأ المسودة ثم أضف العاملين من اللقطة السنوية النشطة.</span>
      </div>
    </header>

    <form className="panel request-create" onSubmit={event => void submit(event)}>
      <div className="panel__header">
        <div><h2>بيانات الطلب الأساسية</h2><p>يمكن استكمال العاملين ومسار الاعتماد بعد حفظ المسودة.</p></div>
        <FilePlus2 size={24} aria-hidden="true" />
      </div>
      <div className="request-create__body">
        <fieldset className="type-picker">
          <legend>نوع الطلب</legend>
          <label className={requestType === 'PROMOTION' ? 'type-card type-card--selected' : 'type-card'}>
            <input type="radio" name="requestType" value="PROMOTION" checked={requestType === 'PROMOTION'} onChange={() => setRequestType('PROMOTION')} />
            <span className="type-card__icon"><BriefcaseBusiness /></span>
            <span><strong>ترقية</strong><small>مسار طلبات الترقية للعاملين</small></span>
          </label>
          <label className={requestType === 'SECONDMENT' ? 'type-card type-card--selected' : 'type-card'}>
            <input type="radio" name="requestType" value="SECONDMENT" checked={requestType === 'SECONDMENT'} onChange={() => setRequestType('SECONDMENT')} />
            <span className="type-card__icon"><UsersRound /></span>
            <span><strong>ندب</strong><small>مسار طلبات الندب بين الوظائف</small></span>
          </label>
        </fieldset>

        <div className="form-grid">
          <label>سنة الدورة
            <span className="field-shell"><CalendarDays size={18} /><input type="number" min="2000" max="2200" required value={cycleYear} onChange={event => setCycleYear(Number(event.target.value))} /></span>
          </label>
          <label>شهر النموذج
            <select value={formMonth} onChange={event => setFormMonth(Number(event.target.value))}>
              {Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{new Intl.DateTimeFormat('ar-EG', { month: 'long' }).format(new Date(2026, index, 1))}</option>)}
            </select>
          </label>
          <label>سنة النموذج
            <input type="number" min="2000" max="2200" required value={formYear} onChange={event => setFormYear(Number(event.target.value))} />
          </label>
        </div>
        <div className="state-banner state-banner--info">
          <UsersRound size={20} /><div><strong>بيانات حقيقية فقط</strong><span>لن تُضاف أي بيانات تجريبية. البحث التالي يعتمد حصراً على اللقطة السنوية النشطة في قاعدة البيانات.</span></div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <footer className="form-actions">
        <button className="button button--secondary" type="button" onClick={() => navigate(-1)}>إلغاء</button>
        <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? 'جارٍ إنشاء المسودة...' : <>إنشاء المسودة والمتابعة <ArrowLeft size={18} /></>}</button>
      </footer>
    </form>
  </div>
}

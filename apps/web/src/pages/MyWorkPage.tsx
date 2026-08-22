import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, RefreshCw } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import {
  STAGE_LABELS,
  WORK_STATE_LABELS,
  type StageExecutionSummary
} from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge, StageChip } from '../components/StatusBadge'

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function MyWorkPage(): React.JSX.Element {
  const [stages, setStages] = useState<StageExecutionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setStages(await workflowApi.myWork())
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) {
    return <EmptyState icon={Briefcase} title="تعذر تحميل عملك" body={error} action={{ to: '/', label: 'عودة للرئيسية' }} />
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>عملي</h1>
        <button type="button" className="icon-button" aria-label="تحديث" onClick={() => void reload()}>
          <RefreshCw size={18} />
        </button>
      </header>

      {stages === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : stages.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="لا يوجد عمل مسند إليك حالياً"
          body="ستظهر هنا المراحل التي يسندها إليك مدير وحدتك."
        />
      ) : (
        <section className="card" aria-label="المراحل المسندة إليك">
          <h2>المراحل المسندة إليك ({stages.length})</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">الطلب</th>
                  <th scope="col">المرحلة</th>
                  <th scope="col">النيابة</th>
                  <th scope="col">حالة العمل</th>
                  <th scope="col">تاريخ الإسناد</th>
                  <th scope="col"><span className="sr-only">إجراءات</span></th>
                </tr>
              </thead>
              <tbody>
                {stages.map(stage => (
                  <tr key={stage.id}>
                    <td><Link to={`/requests/${stage.requestId}`}><strong>{stage.requestNumber}</strong></Link></td>
                    <td><StageChip code={stage.stageCode} /> <small>{STAGE_LABELS[stage.stageCode]}</small></td>
                    <td>{stage.routingUnitNameAr ?? '—'}</td>
                    <td>
                      <StatusBadge status={stage.workState} />
                      {stage.workState === 'CORRECTION_REQUIRED' && (
                        <><br /><small className="warning">{WORK_STATE_LABELS[stage.workState]} — {stage.correctionReason ?? 'أكمل التصحيح ثم ارفع العمل'}</small></>
                      )}
                    </td>
                    <td>{formatDateTime(stage.assignedAt ?? stage.openedAt)}</td>
                    <td><Link to={`/requests/${stage.requestId}`} className="button button--primary">فتح وتنفيذ</Link></td>
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

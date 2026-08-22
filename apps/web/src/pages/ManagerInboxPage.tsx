import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, RefreshCw } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import { STAGE_LABELS, WORK_STATE_LABELS, type ManagerInboxResponse, type StageExecutionSummary, type WorkflowRequestSummary } from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge, StageChip } from '../components/StatusBadge'

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function RejectedRequestCard({
  request,
  busy,
  onRestart,
  onCancel
}: {
  request: WorkflowRequestSummary
  busy: boolean
  onRestart(id: string): void
  onCancel(id: string): void
}): React.JSX.Element {
  return (
    <article className="card card--soft rejected-card">
      <header className="rejected-card__head">
        <Link to={`/requests/${request.id}`}><strong>طلب {request.requestNumber}</strong></Link>
        <span>{request.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</span>
        <StatusBadge status={request.status} />
      </header>
      <p className="muted">
        النيابة: {request.routingUnitNameAr ?? '—'} • التكرار رقم {request.currentIterationNo ?? '—'}
      </p>
      <div className="stage-actions__group">
        <button type="button" className="button button--primary" disabled={busy} onClick={() => onRestart(request.id)}>
          إعادة الإنشاء من البداية (تكرار جديد)
        </button>
        <button type="button" className="button button--danger" disabled={busy} onClick={() => onCancel(request.id)}>
          إلغاء الطلب نهائياً
        </button>
      </div>
    </article>
  )
}

export function ManagerInboxPage(): React.JSX.Element {
  const [inbox, setInbox] = useState<ManagerInboxResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setInbox(await workflowApi.managerInbox())
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function runStageAction(stageId: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      await reload()
    } catch (requestError) {
      setActionError(`${arabicErrorMessage(requestError)} (مرحلة ${stageId.slice(0, 8)}…)` )
    } finally {
      setBusy(false)
    }
  }

  async function restart(id: string): Promise<void> {
    await runStageAction(id, () => workflowApi.restartRequest(id))
  }
  async function cancel(id: string): Promise<void> {
    await runStageAction(id, () => workflowApi.cancelRequest(id))
  }

  if (error) {
    return (
      <EmptyState
        icon={Inbox}
        title="تعذر تحميل صندوق المدير"
        body={error}
        action={{ to: '/', label: 'عودة للرئيسية' }}
      />
    )
  }

  const stages = inbox?.stages ?? []
  const rejected = inbox?.rejectedRequests ?? []

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>صندوق المدير</h1>
        <button type="button" className="icon-button" aria-label="تحديث" onClick={() => void reload()}>
          <RefreshCw size={18} />
        </button>
      </header>

      {actionError && <p className="error" role="alert">{actionError}</p>}

      {stages.length === 0 ? (
        <EmptyState icon={Inbox} title="لا توجد مراحل مفتوحة في صندوقك" body="ستظهر هنا المرحلات المفتوحة التي تديرها وحدتك الحالية." />
      ) : (
        <section aria-label="المراحل المفتوحة" className="card">
          <h2>المراحل المفتوحة ({stages.length})</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">الطلب</th>
                  <th scope="col">النوع</th>
                  <th scope="col">المرحلة</th>
                  <th scope="col">النيابة</th>
                  <th scope="col">حالة العمل</th>
                  <th scope="col">المسند إليه</th>
                  <th scope="col">تاريخ الفتح</th>
                  <th scope="col"><span className="sr-only">إجراءات</span></th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage: StageExecutionSummary) => (
                  <tr key={stage.id}>
                    <td>
                      <Link to={`/requests/${stage.requestId}`}><strong>{stage.requestNumber}</strong></Link>
                      <br /><small className="muted">التكرار {stage.iterationNo} • تنفيذ #{stage.executionNo}</small>
                    </td>
                    <td>{stage.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</td>
                    <td><StageChip code={stage.stageCode} /> <small>{STAGE_LABELS[stage.stageCode]}</small></td>
                    <td>{stage.routingUnitNameAr ?? '—'}</td>
                    <td><StatusBadge status={stage.workState} /><br /><small className="muted">{WORK_STATE_LABELS[stage.workState]}</small></td>
                    <td>
                      {stage.activeAssigneeDisplayName ?? <em className="muted">غير مسند</em>}
                      {stage.suggestedAssigneeDisplayName && !stage.activeAssigneeDisplayName && (
                        <>
                          <br />
                          <small className="hint">مقترح: {stage.suggestedAssigneeDisplayName}</small>
                        </>
                      )}
                    </td>
                    <td>{formatDateTime(stage.openedAt)}</td>
                    <td>
                      <div className="row-actions">
                        {stage.workState === 'MANAGER_INBOX' && (
                          <button
                            type="button"
                            className="button button--secondary"
                            disabled={busy}
                            onClick={() => void runStageAction(stage.id, () => workflowApi.takeStage(stage.id))}
                            title="تنفيذ المرحلة بنفسك"
                          >
                            استلام مباشر
                          </button>
                        )}
                        <Link to={`/requests/${stage.requestId}`} className="button button--secondary">فتح الطلب</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">الإسناد وإعادة الإسناد يتم من شاشة تفاصيل الطلب لضمان عرض بيانات المرحلة كاملة.</p>
        </section>
      )}

      {rejected.length > 0 && (
        <section aria-label="طلبات مرفوضة بانتظار قرارك">
          <h2>طلبات مرفوضة بانتظار قرار الموارد البشرية ({rejected.length})</h2>
          {rejected.map(request => (
            <RejectedRequestCard key={request.id} request={request} busy={busy} onRestart={id => void restart(id)} onCancel={id => void cancel(id)} />
          ))}
        </section>
      )}
    </div>
  )
}

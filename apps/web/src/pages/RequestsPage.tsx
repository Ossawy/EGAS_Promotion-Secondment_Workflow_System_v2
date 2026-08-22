import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { History } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import {
  REQUEST_STATUS_LABELS,
  STAGE_LABELS,
  type WorkflowRequestStatus,
  type WorkflowRequestSummary
} from '../api/workflow-types'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge, StageChip } from '../components/StatusBadge'

const PAGE_SIZE = 50

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value))
}

/**
 * Request history over GET /api/workflow/requests (server-scoped to what the caller may see).
 * Text/status/type filters run client-side within the loaded page; the server remains the access boundary.
 */
export function RequestsPage(): React.JSX.Element {
  const [searchParams] = useSearchParams()
  const initialQuery = searchParams.get('q') ?? ''

  const [requests, setRequests] = useState<WorkflowRequestSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [statusFilter, setStatusFilter] = useState<'' | WorkflowRequestStatus>('')
  const [typeFilter, setTypeFilter] = useState<'' | 'PROMOTION' | 'SECONDMENT'>('')
  const [skip, setSkip] = useState(0)

  const load = useCallback(async () => {
    try {
      setError(null)
      setRequests(await workflowApi.listRequests(skip, PAGE_SIZE, {query,status:statusFilter,requestType:typeFilter||undefined}))
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [query,skip,statusFilter,typeFilter])

  useEffect(() => {
    const timer=window.setTimeout(()=>void load(),250)
    return ()=>window.clearTimeout(timer)
  }, [load])

  const filtered = useMemo(() => requests ?? [], [requests])

  return (
    <div className="page-stack">
      <header className="page-header"><h1>الطلبات والسجل</h1></header>

      <section className="card filters" aria-label="تصفية الطلبات">
        <label className="field">
          بحث
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); }} placeholder="رقم الطلب أو النيابة…" maxLength={120} />
        </label>
        <label className="field">
          الحالة
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as '' | WorkflowRequestStatus)}>
            <option value="">الكل</option>
            {Object.entries(REQUEST_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          النوع
          <select value={typeFilter} onChange={event => setTypeFilter(event.target.value as '' | 'PROMOTION' | 'SECONDMENT')}>
            <option value="">الكل</option>
            <option value="PROMOTION">ترقية</option>
            <option value="SECONDMENT">ندب</option>
          </select>
        </label>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {requests === null ? (
        <p className="loading" role="status">جارٍ التحميل…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={History} title="لا توجد طلبات مطابقة" body="جرّب تعديل عوامل التصفية، أو ستظهر هنا الطلبات التي تشارك بها." />
      ) : (
        <section className="card" aria-label="قائمة الطلبات">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">رقم الطلب</th>
                  <th scope="col">النوع</th>
                  <th scope="col">الحالة</th>
                  <th scope="col">المرحلة الحالية</th>
                  <th scope="col">التكرار</th>
                  <th scope="col">النيابة</th>
                  <th scope="col">تاريخ الإنشاء</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(request => (
                  <tr key={request.id}>
                    <td><Link to={`/requests/${request.id}`}><strong>{request.requestNumber}</strong></Link></td>
                    <td>{request.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</td>
                    <td><StatusBadge status={request.status} /></td>
                    <td>
                      {request.currentStageCode
                        ? <><StageChip code={request.currentStageCode} /> <small>{STAGE_LABELS[request.currentStageCode]}</small></>
                        : '—'}
                    </td>
                    <td>{request.currentIterationNo ?? '—'}</td>
                    <td>{request.routingUnitNameAr ?? '—'}</td>
                    <td>{formatDateTime(request.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="table-footer">
            <button type="button" className="button button--secondary" disabled={skip === 0} onClick={() => setSkip(value => Math.max(0, value - PAGE_SIZE))}>
              الصفحة السابقة
            </button>
            <span className="muted">عرض {filtered.length} طلباً</span>
            <button type="button" className="button button--secondary" disabled={(requests?.length ?? 0) < PAGE_SIZE} onClick={() => setSkip(value => value + PAGE_SIZE)}>
              الصفحة التالية
            </button>
          </footer>
        </section>
      )}
    </div>
  )
}

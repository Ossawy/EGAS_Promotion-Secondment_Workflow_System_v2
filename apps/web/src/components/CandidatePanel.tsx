import { useState } from 'react'
import { Search, Trash2, UserPlus } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { CandidateLookupPreview, RequestCandidateSummary } from '../api/workflow-types'

function frozenRow(data: Record<string, unknown>, keys: string[]): [string, string][] {
  return keys
    .map(key => {
      const value = data[key]
      if (value === null || value === undefined || value === '') return null
      return [key, String(value)] as [string, string]
    })
    .filter((entry): entry is [string, string] => entry !== null)
}

const DISPLAY_KEYS = [
  'employeeName',
  'personnelNumber',
  'currentJobTitle',
  'employeeGroup',
  'employeeSubgroup',
  'sourceRoutingLabel',
  'lastPromotionDate',
  'experienceYears',
  'experienceMonths',
  'experienceDays',
  'currentJobTenureYears',
  'currentJobTenureMonths',
  'currentJobTenureDays',
  'originalQualification',
  'originalQualificationDate',
  'performanceRating',
  'performanceReportYear'
]

const DISPLAY_LABELS: Record<string, string> = {
  employeeName: 'اسم العامل', personnelNumber: 'رقم العامل', currentJobTitle: 'الوظيفة الحالية',
  employeeGroup: 'مجموعة العاملين', employeeSubgroup: 'المجموعة الفرعية', sourceRoutingLabel: 'النيابة / المساعد',
  lastPromotionDate: 'تاريخ أقدمية آخر ترقية', experienceYears: 'سنوات الخبرة', experienceMonths: 'شهور الخبرة',
  experienceDays: 'أيام الخبرة', currentJobTenureYears: 'سنوات شغل الوظيفة الحالية',
  currentJobTenureMonths: 'شهور شغل الوظيفة الحالية', currentJobTenureDays: 'أيام شغل الوظيفة الحالية',
  originalQualification: 'المؤهل الأصلي', originalQualificationDate: 'تاريخ المؤهل الأصلي',
  performanceRating: 'تقرير الكفاية', performanceReportYear: 'سنة تقرير الكفاية'
}

function FrozenDataList({ data }: { data: Record<string, unknown> }): React.JSX.Element | null {
  const rows = frozenRow(data, DISPLAY_KEYS)
  if (rows.length === 0) return null
  return (
    <dl className="frozen-data">
      {rows.map(([key, value]) => (
        <div key={key}><dt>{DISPLAY_LABELS[key] ?? 'بيان سنوي'}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  )
}

/**
 * HR-manager candidate preparation for DRAFT P1/S1 requests: safe request-scoped
 * Personnel Number lookup (preview only) followed by the authoritative add command.
 */
export function CandidatePanel({
  requestId,
  candidates,
  canEdit,
  onChanged
}: {
  requestId: string
  candidates: RequestCandidateSummary[]
  canEdit: boolean
  onChanged(): void
}): React.JSX.Element {
  const [personnelNumber, setPersonnelNumber] = useState('')
  const [preview, setPreview] = useState<CandidateLookupPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function lookup(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const value = personnelNumber.trim()
    if (!value) return
    setPreview(null)
    setError(null)
    setBusy(true)
    try {
      setPreview(await workflowApi.lookupCandidate(requestId, value))
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  async function add(): Promise<void> {
    const value = personnelNumber.trim()
    if (!value) return
    setBusy(true)
    setError(null)
    try {
      await workflowApi.addCandidate(requestId, value)
      setPreview(null)
      setPersonnelNumber('')
      onChanged()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  async function remove(candidateId: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await workflowApi.removeCandidate(requestId, candidateId)
      onChanged()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-label="مرشحو الطلب">
      <h2>المرشحون ({candidates.length})</h2>
      {error && <p className="error" role="alert">{error}</p>}

      {canEdit && (
        <>
          <form className="lookup-form" onSubmit={event => void lookup(event)}>
            <label className="field">
              رقم الموظف
              <span className="input-with-button">
                <input
                  type="text"
                  inputMode="numeric"
                  value={personnelNumber}
                  onChange={event => setPersonnelNumber(event.target.value)}
                  maxLength={30}
                  placeholder="مثال: 000101"
                  required
                />
                <button type="submit" className="button button--secondary" disabled={busy || !personnelNumber.trim()}>
                  <Search size={16} aria-hidden="true" /> بحث في اللقطة السنوية
                </button>
              </span>
            </label>
          </form>

          {preview && (
            <article className="card card--soft preview-card">
              <header className="preview-card__head">
                <strong>{preview.employeeName || preview.personnelNumber}</strong>
                <span className="mono">{preview.personnelNumber}</span>
                <span>{preview.currentJobTitle ?? ''}</span>
                <span className="badge badge--info">لقطة {preview.snapshotYear}</span>
                {preview.alreadyAddedToRequest && <span className="badge badge--warning">مضاف مسبقاً</span>}
              </header>
              <FrozenDataList data={preview.frozenData} />
              <button type="button" className="button button--primary" disabled={busy || preview.alreadyAddedToRequest} onClick={() => void add()}>
                <UserPlus size={16} aria-hidden="true" /> إضافة كمرشح
              </button>
            </article>
          )}
        </>
      )}

      {candidates.length === 0 ? (
        <p className="empty">لم تتم إضافة مرشحين بعد.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الموظف</th>
                <th scope="col">الاسم</th>
                <th scope="col">الوظيفة الحالية</th>
                {canEdit && <th scope="col"><span className="sr-only">إجراءات</span></th>}
              </tr>
            </thead>
            <tbody>
              {candidates.map(candidate => (
                <tr key={candidate.id}>
                  <td className="mono">{candidate.personnelNumber}</td>
                  <td>{candidate.employeeName}</td>
                  <td>{candidate.currentJobTitle ?? '—'}</td>
                  {canEdit && (
                    <td>
                      <button type="button" className="icon-button button--danger" aria-label={`إزالة ${candidate.employeeName}`} disabled={busy} onClick={() => void remove(candidate.id)}>
                        <Trash2 size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {candidates.length > 0 && (
        <details className="frozen-details">
          <summary>عرض البيانات السنوية المجمّدة للمرشحين</summary>
          {candidates.map(candidate => (
            <div key={candidate.id}>
              <h4>{candidate.employeeName} <span className="mono">({candidate.personnelNumber})</span></h4>
              <FrozenDataList data={candidate.frozenData} />
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { promotionApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { PromotionDecisionSummary } from '../api/workflow-types'

/**
 * Promotion decisions surface.
 * - P4 (AUTH manager, MANAGER_REVIEW not required for editing): editable per candidate.
 * - P4O and every other context: strictly read-only view of authoritative decisions.
 * The server remains the authority; the editor simply posts to the decision endpoint.
 */
export function PromotionDecisionsPanel({
  requestId,
  stageExecutionId,
  revision,
  editable
}: {
  requestId: string
  /** Current P4 stage execution id; null outside the editable P4 context. */
  stageExecutionId: string | null
  revision: number
  editable: boolean
}): React.JSX.Element {
  const [decisions, setDecisions] = useState<PromotionDecisionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { decisionType: 'SAME_POSITION' | 'OTHER_POSITION', targetJobTitle: string, recommendation: string, notes: string }>>({})
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await promotionApi.decisions(requestId)
      setDecisions(list)
      setDrafts(current => {
        const next = { ...current }
        for (const decision of list) {
          if (!next[decision.candidateId]) {
            next[decision.candidateId] = {
              decisionType: decision.decisionType,
              targetJobTitle: decision.targetJobTitle ?? '',
              recommendation: decision.recommendation,
              notes: decision.notes ?? ''
            }
          }
        }
        return next
      })
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [requestId])

  useEffect(() => {
    void load()
  }, [load, revision])

  function updateDraft(candidateId: string, patch: Partial<{ decisionType: 'SAME_POSITION' | 'OTHER_POSITION', targetJobTitle: string, recommendation: string, notes: string }>): void {
    setDrafts(current => {
      const base = current[candidateId]
        ?? { decisionType: 'SAME_POSITION' as const, targetJobTitle: '', recommendation: '', notes: '' }
      return { ...current, [candidateId]: { ...base, ...patch } }
    })
  }

  async function save(candidateId: string): Promise<void> {
    if (!editable || !stageExecutionId) return
    const draft = drafts[candidateId]
    if (!draft) return
    setBusyCandidateId(candidateId)
    setError(null)
    setNotice(null)
    try {
      await promotionApi.saveDecision(
        stageExecutionId,
        candidateId,
        {
          decisionType: draft.decisionType,
          targetJobTitle: draft.decisionType === 'OTHER_POSITION' ? draft.targetJobTitle.trim() : null,
          recommendation: draft.recommendation.trim(),
          notes: draft.notes.trim() ? draft.notes.trim() : null
        }
      )
      setNotice('تم حفظ القرار.')
      await load()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusyCandidateId(null)
    }
  }

  return (
    <section className="card" aria-label="قرارات الترقية">
      <h2>قرارات نيابة الاعتماد (P4)</h2>
      <p className="muted">لكل مرشح: ترقية على نفس الوظيفة أو ترقية على وظيفة أخرى داخل نفس النيابة، مع التوصية.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {!editable && <p className="badge badge--neutral">عرض للقراءة فقط — القرارات المعتمدة لا تعدل من هذه المرحلة.</p>}
      {decisions === null ? (
        <p className="muted">جارٍ التحميل…</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">المرشح</th>
                <th scope="col">القرار</th>
                <th scope="col">الوظيفة المستهدفة</th>
                <th scope="col">التوصية</th>
                <th scope="col">ملاحظات</th>
                {editable && <th scope="col"><span className="sr-only">حفظ</span></th>}
              </tr>
            </thead>
            <tbody>
              {decisions.map(decision => {
                const draft = drafts[decision.candidateId]
                return (
                  <tr key={decision.id}>
                    <td>{decision.employeeName}<br /><span className="mono">{decision.personnelNumber}</span></td>
                    {editable && draft ? (
                      <>
                        <td>
                          <label className="radio-row">
                            <input
                              type="radio"
                              name={`decision-${decision.candidateId}`}
                              checked={draft.decisionType === 'SAME_POSITION'}
                              onChange={() => updateDraft(decision.candidateId, { decisionType: 'SAME_POSITION' })}
                            />
                            نفس الوظيفة
                          </label>
                          <label className="radio-row">
                            <input
                              type="radio"
                              name={`decision-${decision.candidateId}`}
                              checked={draft.decisionType === 'OTHER_POSITION'}
                              onChange={() => updateDraft(decision.candidateId, { decisionType: 'OTHER_POSITION' })}
                            />
                            وظيفة أخرى
                          </label>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={draft.targetJobTitle}
                            onChange={event => updateDraft(decision.candidateId, { targetJobTitle: event.target.value })}
                            maxLength={240}
                            disabled={draft.decisionType !== 'OTHER_POSITION'}
                            required={draft.decisionType === 'OTHER_POSITION'}
                            aria-label={`المسمى المستهدف لـ ${decision.employeeName}`}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={draft.recommendation}
                            onChange={event => updateDraft(decision.candidateId, { recommendation: event.target.value })}
                            maxLength={80}
                            placeholder="مثال: ترشيح / تأجيل"
                            aria-label={`توصية ${decision.employeeName}`}
                          />
                        </td>
                        <td>
                          <textarea
                            value={draft.notes}
                            onChange={event => updateDraft(decision.candidateId, { notes: event.target.value })}
                            rows={2}
                            maxLength={4000}
                            aria-label={`ملاحظات ${decision.employeeName}`}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button button--primary"
                            disabled={
                              busyCandidateId === decision.candidateId
                              || !draft.recommendation.trim()
                              || (draft.decisionType === 'OTHER_POSITION' && !draft.targetJobTitle.trim())
                            }
                            onClick={() => void save(decision.candidateId)}
                          >
                            حفظ
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{decision.decisionType === 'SAME_POSITION' ? 'نفس الوظيفة' : 'وظيفة أخرى'}</td>
                        <td>{decision.effectiveNominatedJob ?? decision.targetJobTitle ?? '—'}</td>
                        <td>{decision.recommendation}</td>
                        <td>{decision.notes ?? '—'}</td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

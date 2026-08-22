import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { referenceApi, secondmentApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type {
  JobCategoryOption,
  QualificationStatusOption,
  RequestCandidateSummary,
  SecondmentPositionOptionSummary,
  SecondmentSelectionSummary
} from '../api/workflow-types'

type PreparationDraft = { lastPromotionReport: string, jobCategoryCode: string }
type OptionDraft = { positionTitle: string, organizationalDependency: string, qualificationStatus: string }

function emptyOptionDraft(): OptionDraft {
  return { positionTitle: '', organizationalDependency: '', qualificationStatus: '' }
}

/**
 * Secondment stage data surface.
 * - edit-s2: ORG preparation + proposed-position options (manager or assigned employee).
 * - edit-s3: AUTH selects exactly ONE existing S2 option per candidate.
 * - readonly: authoritative options/selections only.
 */
export function SecondmentStagePanel({
  requestId,
  stageExecutionId,
  candidates,
  revision,
  mode
}: {
  requestId: string
  /** Current stage execution id when editing is allowed; null for read-only contexts. */
  stageExecutionId: string | null
  candidates: RequestCandidateSummary[]
  revision: number
  mode: 'edit-s2' | 'edit-s3' | 'readonly'
}): React.JSX.Element {
  const [options, setOptions] = useState<SecondmentPositionOptionSummary[] | null>(null)
  const [selections, setSelections] = useState<SecondmentSelectionSummary[]>([])
  const [jobCategories, setJobCategories] = useState<JobCategoryOption[]>([])
  const [qualificationStatuses, setQualificationStatuses] = useState<QualificationStatusOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prepDrafts, setPrepDrafts] = useState<Record<string, PreparationDraft>>({})
  const [optionDrafts, setOptionDrafts] = useState<Record<string, OptionDraft>>({})
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null)
  const [editOptionDraft, setEditOptionDraft] = useState<OptionDraft>(emptyOptionDraft())

  const load = useCallback(async () => {
    try {
      const [optionList, selectionList] = await Promise.all([
        secondmentApi.options(requestId),
        secondmentApi.selections(requestId).catch(() => [] as SecondmentSelectionSummary[])
      ])
      setOptions(optionList)
      setSelections(selectionList)
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [requestId])

  useEffect(() => {
    void load()
  }, [load, revision])

  useEffect(() => {
    let active = true
    Promise.all([referenceApi.jobCategories(), referenceApi.qualificationStatuses()])
      .then(([categories, statuses]) => {
        if (!active) return
        setJobCategories(categories.filter(entry => entry.isActive))
        setQualificationStatuses(statuses.filter(entry => entry.isActive))
      })
      .catch(requestError => { if (active) setError(arabicErrorMessage(requestError)) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    // Prefill preparation drafts from frozen accepted_data (server-stored values).
    setPrepDrafts(current => {
      const next = { ...current }
      for (const candidate of candidates) {
        if (next[candidate.id]) continue
        const stored = candidate.acceptedData?.secondmentS2Preparation as Partial<PreparationDraft> | undefined
        next[candidate.id] = {
          lastPromotionReport: typeof stored?.lastPromotionReport === 'string' ? stored.lastPromotionReport : '',
          jobCategoryCode: typeof stored?.jobCategoryCode === 'string' ? stored.jobCategoryCode : ''
        }
      }
      return next
    })
  }, [candidates])

  function updatePrep(candidateId: string, patch: Partial<PreparationDraft>): void {
    setPrepDrafts(current => ({ ...current, [candidateId]: { ...(current[candidateId] ?? { lastPromotionReport: '', jobCategoryCode: '' }), ...patch } }))
  }

  async function run(action: () => Promise<unknown>, successMessage?: string): Promise<boolean> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (successMessage) setNotice(successMessage)
      await load()
      return true
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
      return false
    } finally {
      setBusy(false)
    }
  }

  const optionsByCandidate = new Map<string, SecondmentPositionOptionSummary[]>()
  for (const option of options ?? []) {
    const bucket = optionsByCandidate.get(option.candidateId) ?? []
    bucket.push(option)
    optionsByCandidate.set(option.candidateId, bucket)
  }
  const selectionByCandidate = new Map(selections.map(selection => [selection.candidateId, selection]))

  return (
    <section className="card" aria-label="بيانات الندب">
      <h2>{mode === 'edit-s3' ? 'اعتماد وظيفة الندب (S3)' : 'الوظائف المقترحة للندب'}</h2>
      <p className="muted">
        {mode === 'edit-s3'
          ? 'اختر وظيفة واحدة فقط لكل مرشح من الخيارات المعتمدة في مرحلة S2. لا يمكن إضافة وظائف جديدة من هذه المرحلة.'
          : mode === 'edit-s2'
            ? 'أكمل بيانات الإعداد وأضف خيار وظيفة واحد أو أكثر لكل مرشح ضمن نفس النيابة.'
            : 'عرض للقراءة فقط.'}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}

      {options === null ? (
        <p className="muted">جارٍ التحميل…</p>
      ) : candidates.length === 0 ? (
        <p className="empty">لا يوجد مرشحون.</p>
      ) : (
        <div className="candidate-stack">
          {candidates.map(candidate => {
            const candidateOptions = optionsByCandidate.get(candidate.id) ?? []
            const currentSelection = selectionByCandidate.get(candidate.id)
            const prep = prepDrafts[candidate.id] ?? { lastPromotionReport: '', jobCategoryCode: '' }

            return (
              <article key={candidate.id} className="candidate-block">
                <header>
                  <strong>{candidate.employeeName}</strong>
                  <span className="mono">{candidate.personnelNumber}</span>
                  {currentSelection && <span className="badge badge--success">مختار: {currentSelection.positionTitle}</span>}
                </header>

                {mode === 'edit-s2' && stageExecutionId && (
                  <>
                    <div className="prep-grid">
                      <label className="field">
                        تقرير آخر ترقية
                        <textarea
                          value={prep.lastPromotionReport}
                          onChange={event => updatePrep(candidate.id, { lastPromotionReport: event.target.value })}
                          rows={2}
                          maxLength={4000}
                        />
                      </label>
                      <label className="field">
                        فئة الوظيفة
                        <select
                          value={prep.jobCategoryCode}
                          onChange={event => updatePrep(candidate.id, { jobCategoryCode: event.target.value })}
                        >
                          <option value="" disabled>اختر الفئة…</option>
                          {jobCategories.map(category => (
                            <option key={category.code} value={category.code}>{category.code} — {category.name}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={busy || !prep.lastPromotionReport.trim() || !prep.jobCategoryCode}
                        onClick={() => void run(
                          () => secondmentApi.savePreparation(stageExecutionId, candidate.id, {
                            lastPromotionReport: prep.lastPromotionReport.trim(),
                            jobCategoryCode: prep.jobCategoryCode
                          }),
                          'تم حفظ بيانات الإعداد.'
                        )}
                      >
                        حفظ الإعداد
                      </button>
                    </div>

                    <ul className="option-list">
                      {candidateOptions.map(option => (
                        <li key={option.id} className="option-item">
                          {editingOptionId === option.id ? (
                            <form
                              className="option-edit"
                              onSubmit={event => {
                                event.preventDefault()
                                void run(async () => {
                                  await secondmentApi.updateOption(stageExecutionId, option.id, {
                                    positionTitle: editOptionDraft.positionTitle.trim(),
                                    organizationalDependency: editOptionDraft.organizationalDependency.trim(),
                                    qualificationStatus: editOptionDraft.qualificationStatus
                                  })
                                  setEditingOptionId(null)
                                }, 'تم تحديث الخيار.')
                              }}
                            >
                              <input type="text" value={editOptionDraft.positionTitle} onChange={event => setEditOptionDraft({ ...editOptionDraft, positionTitle: event.target.value })} maxLength={240} required aria-label="المسمى الوظيفي" placeholder="المسمى الوظيفي المقترح" />
                              <input type="text" value={editOptionDraft.organizationalDependency} onChange={event => setEditOptionDraft({ ...editOptionDraft, organizationalDependency: event.target.value })} maxLength={240} required aria-label="الجهة التابع لها" placeholder="الجهة / التبعية التنظيمية" />
                              <select value={editOptionDraft.qualificationStatus} onChange={event => setEditOptionDraft({ ...editOptionDraft, qualificationStatus: event.target.value })} required aria-label="حالة التأهيل">
                                <option value="" disabled>حالة التأهيل…</option>
                                {qualificationStatuses.map(status => (
                                  <option key={status.code} value={status.code}>{status.code} — {status.name}</option>
                                ))}
                              </select>
                              <button type="submit" className="button button--primary" disabled={busy}>تحديث</button>
                              <button type="button" className="button button--secondary" onClick={() => { setEditingOptionId(null); setEditOptionDraft(emptyOptionDraft()) }}>إلغاء</button>
                            </form>
                          ) : (
                            <>
                              <span><strong>{option.positionTitle}</strong></span>
                              <span>{option.organizationalDependency ?? '—'}</span>
                              <span>{option.qualificationStatusCode}{option.qualificationStatusName ? ` — ${option.qualificationStatusName}` : ''}</span>
                              <span className="muted mono">#{option.displayOrder}</span>
                              <span className="option-actions">
                                <button type="button" className="button button--secondary" disabled={busy} onClick={() => {
                                  setEditingOptionId(option.id)
                                  setEditOptionDraft({
                                    positionTitle: option.positionTitle,
                                    organizationalDependency: option.organizationalDependency ?? '',
                                    qualificationStatus: option.qualificationStatusCode
                                  })
                                }}>
                                  تعديل
                                </button>
                                <button
                                  type="button"
                                  className="icon-button button--danger"
                                  aria-label={`حذف خيار ${option.positionTitle}`}
                                  disabled={busy}
                                  onClick={() => void run(() => secondmentApi.removeOption(stageExecutionId, option.id), 'تم حذف الخيار.')}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>

                    <form
                      className="option-add"
                      onSubmit={event => {
                        event.preventDefault()
                        const draft = optionDrafts[candidate.id]
                        if (!draft?.positionTitle.trim() || !draft.organizationalDependency.trim() || !draft.qualificationStatus) return
                        void run(async () => {
                          await secondmentApi.addOption(stageExecutionId, candidate.id, {
                            positionTitle: draft.positionTitle.trim(),
                            organizationalDependency: draft.organizationalDependency.trim(),
                            qualificationStatus: draft.qualificationStatus
                          })
                          setOptionDrafts(current => ({ ...current, [candidate.id]: emptyOptionDraft() }))
                        }, 'تمت إضافة الخيار.')
                      }}
                    >
                      <label className="sr-only" htmlFor={`opt-title-${candidate.id}`}>المسمى الوظيفي المقترح</label>
                      <input id={`opt-title-${candidate.id}`} type="text" value={optionDrafts[candidate.id]?.positionTitle ?? ''} onChange={event => setOptionDrafts(current => ({ ...current, [candidate.id]: { ...(current[candidate.id] ?? emptyOptionDraft()), positionTitle: event.target.value } }))} maxLength={240} placeholder="المسمى الوظيفي المقترح" required />
                      <label className="sr-only" htmlFor={`opt-dep-${candidate.id}`}>التبعية التنظيمية</label>
                      <input id={`opt-dep-${candidate.id}`} type="text" value={optionDrafts[candidate.id]?.organizationalDependency ?? ''} onChange={event => setOptionDrafts(current => ({ ...current, [candidate.id]: { ...(current[candidate.id] ?? emptyOptionDraft()), organizationalDependency: event.target.value } }))} maxLength={240} placeholder="الجهة / التبعية التنظيمية" required />
                      <label className="sr-only" htmlFor={`opt-qual-${candidate.id}`}>حالة التأهيل</label>
                      <select id={`opt-qual-${candidate.id}`} value={optionDrafts[candidate.id]?.qualificationStatus ?? ''} onChange={event => setOptionDrafts(current => ({ ...current, [candidate.id]: { ...(current[candidate.id] ?? emptyOptionDraft()), qualificationStatus: event.target.value } }))} required>
                        <option value="" disabled>حالة التأهيل…</option>
                        {qualificationStatuses.map(status => (
                          <option key={status.code} value={status.code}>{status.code} — {status.name}</option>
                        ))}
                      </select>
                      <button type="submit" className="button button--primary" disabled={busy}>
                        <Plus size={15} aria-hidden="true" /> إضافة خيار
                      </button>
                    </form>
                  </>
                )}

                {(mode === 'edit-s3' || mode === 'readonly') && candidateOptions.length > 0 && (
                  <fieldset className="selection-group">
                    <legend>الخيارات المعتمدة من S2</legend>
                    {candidateOptions.map(option => (
                      <label key={option.id} className="radio-row">
                        <input
                          type="radio"
                          name={`selection-${candidate.id}`}
                          value={option.id}
                          checked={currentSelection?.selectedOptionId === option.id}
                          disabled={mode !== 'edit-s3' || !stageExecutionId || busy}
                          onChange={() => {
                            if (!stageExecutionId) return
                            void run(
                              () => secondmentApi.saveSelection(stageExecutionId, candidate.id, option.id),
                              'تم حفظ الاختيار.'
                            )
                          }}
                        />
                        <span>
                          <strong>{option.positionTitle}</strong> — {option.organizationalDependency ?? '—'}
                          {' '}({option.qualificationStatusCode}{option.qualificationStatusName ? ` ${option.qualificationStatusName}` : ''})
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {(mode === 'edit-s3' || mode === 'readonly') && candidateOptions.length === 0 && (
                  <p className="warning">لا توجد خيارات معتمدة لهذا المرشح من مرحلة S2.</p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

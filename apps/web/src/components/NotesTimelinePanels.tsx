import { useCallback, useEffect, useState } from 'react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { RequestCandidateSummary, TimelineEvent, WorkflowNoteSummary } from '../api/workflow-types'

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function NotesPanel({
  requestId,
  candidates,
  revision,
  canWrite
}: {
  requestId: string
  candidates: RequestCandidateSummary[]
  revision: number
  canWrite: boolean
}): React.JSX.Element {
  const [notes, setNotes] = useState<WorkflowNoteSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setNotes(await workflowApi.getNotes(requestId))
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [requestId])

  useEffect(() => {
    void load()
  }, [load, revision])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!body.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await workflowApi.addNote(requestId, body.trim(), candidateId || null)
      setBody('')
      setCandidateId('')
      await load()
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-label="الملاحظات">
      <h2>الملاحظات</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {canWrite && (
        <form className="note-form" onSubmit={event => void submit(event)}>
          <label className="field">
            إضافة ملاحظة
            <textarea
              value={body}
              onChange={event => setBody(event.target.value)}
              maxLength={4000}
              rows={3}
              required
              placeholder="نص الملاحظة (تُحفظ في السجل ولا يمكن حذفها)"
            />
          </label>
          {candidates.length > 0 && (
            <label className="field">
              ربط بمرشح (اختياري)
              <select value={candidateId} onChange={event => setCandidateId(event.target.value)}>
                <option value="">— عام —</option>
                {candidates.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>{candidate.employeeName} ({candidate.personnelNumber})</option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="button button--primary" disabled={!body.trim() || busy}>إضافة الملاحظة</button>
        </form>
      )}
      {notes === null ? (
        <p className="muted">جارٍ التحميل…</p>
      ) : notes.length === 0 ? (
        <p className="empty">لا توجد ملاحظات.</p>
      ) : (
        <ul className="notes-list">
          {[...notes].reverse().map(note => (
            <li key={note.id} className="note-item">
              <header>
                <strong>{note.authorDisplayName}</strong>
                <span className="muted">
                  {note.unitName ?? ''}{note.stageCode ? ` • ${note.stageCode}` : ''} • {formatDateTime(note.createdAt)}
                </span>
              </header>
              <p>{note.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const TIMELINE_KIND_LABELS: Record<TimelineEvent['kind'], string> = {
  ITERATION: 'تكرار',
  STAGE_EXECUTION: 'مرحلة تنفيذ',
  WORK_ASSIGNMENT: 'إسناد عمل',
  STAGE_ACTION: 'إجراء مرحلة',
  NOTE: 'ملاحظة',
  SUBMISSION_SNAPSHOT: 'لقطة إثبات',
  REQUEST_STATUS: 'حالة الطلب'
}

export function TimelinePanel({ requestId, revision }: { requestId: string, revision: number }): React.JSX.Element {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    workflowApi.getTimeline(requestId)
      .then(timeline => { if (active) setEvents([...timeline].reverse()) })
      .catch(requestError => { if (active) setError(arabicErrorMessage(requestError)) })
    return () => { active = false }
  }, [requestId, revision])

  return (
    <section className="card" aria-label="السجل الزمني">
      <h2>السجل الزمني</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {events === null ? (
        <p className="muted">جارٍ التحميل…</p>
      ) : events.length === 0 ? (
        <p className="empty">لا توجد أحداث مسجلة بعد.</p>
      ) : (
        <ol className="timeline">
          {events.map(event => (
            <li key={`${event.kind}-${event.id}`} className="timeline__item">
              <span className={`timeline__kind timeline__kind--${event.kind.toLowerCase()}`}>{TIMELINE_KIND_LABELS[event.kind]}</span>
              <div className="timeline__body">
                <strong>{event.title}</strong>
                <small className="muted">
                  {formatDateTime(event.timestamp)}
                  {event.actorDisplayName ? ` • ${event.actorDisplayName}` : ''}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

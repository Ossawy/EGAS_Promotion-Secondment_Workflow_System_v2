import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Inbox, RefreshCw } from 'lucide-react'
import { workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import {
  REQUEST_STATUS_LABELS,
  STAGE_LABELS,
  WORK_STATE_LABELS,
  type RequestCandidateSummary,
  type StageExecutionSummary,
  type WorkflowRequestStatus,
  type WorkflowRequestSummary,
  type WorkflowSignoffView
} from '../api/workflow-types'
import { CandidatePanel } from '../components/CandidatePanel'
import { DocumentPanel } from '../components/DocumentPanel'
import { NotesPanel, TimelinePanel } from '../components/NotesTimelinePanels'
import { PromotionDecisionsPanel } from '../components/PromotionDecisionsPanel'
import { SecondmentStagePanel } from '../components/SecondmentStagePanel'
import { SignoffsView } from '../components/SignoffsView'
import { StageActionsPanel } from '../components/StageActionsPanel'
import { StatusBadge, StageChip } from '../components/StatusBadge'
import { EmptyState } from '../components/EmptyState'
import { useAuth } from '../auth/AuthProvider'

type Detail = WorkflowRequestSummary & { candidates: RequestCandidateSummary[] }

const INITIAL_STAGE_CODES = new Set(['P1', 'S1'])
const DOMAIN_EDITABLE_WORK_STATES = new Set(['ASSIGNED', 'IN_PROGRESS', 'CORRECTION_REQUIRED'])

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function RequestDetailPage(): React.JSX.Element {
  const { id } = useParams()
  const { user } = useAuth()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [signoffs, setSignoffs] = useState<WorkflowSignoffView[]>([])
  const [myWorkStages, setMyWorkStages] = useState<StageExecutionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [notFound, setNotFound] = useState(false)

  const requestId = typeof id === 'string' ? id : ''

  const reload = useCallback(async () => {
    if (!requestId) return
    setError(null)
    try {
      const loaded = await workflowApi.getRequest(requestId)
      const signoffsLoaded = await workflowApi.getSignoffs(requestId).catch(() => [] as WorkflowSignoffView[])
      // Identity resolution for presentation only: does the viewer hold the active
      // WorkAssignment on the current execution? The server enforces every action.
      const myWork = user?.accountType === 'OPERATIONAL'
        ? await workflowApi.myWork().catch(() => [] as StageExecutionSummary[])
        : []
      const managedStages = user?.operationalContext?.isManager
        ? (await workflowApi.managerInbox().catch(() => ({ stages: [], rejectedRequests: [] }))).stages
        : []
      setDetail(loaded)
      setSignoffs(signoffsLoaded)
      setMyWorkStages([...myWork, ...managedStages.filter(stage => !myWork.some(item => item.id === stage.id))])
    } catch (requestError) {
      setNotFound(true)
      setError(arabicErrorMessage(requestError))
    }
  }, [requestId, user])

  useEffect(() => {
    void reload()
  }, [reload, revision])

  async function runRequestAction(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      await reload()
      setRevision(value => value + 1)
    } catch (requestError) {
      setActionError(arabicErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  const currentStage = useMemo<StageExecutionSummary | null>(() => {
    if (!detail?.currentExecutionId || !detail.currentStageCode) return null
    const mine = myWorkStages.find(stage => stage.id === detail.currentExecutionId)
    if (mine) return mine
    return {
      id: detail.currentExecutionId,
      iterationId: detail.currentIterationId ?? '',
      iterationNo: detail.currentIterationNo ?? 1,
      requestId: detail.id,
      requestNumber: detail.requestNumber,
      requestType: detail.requestType,
      routingUnitId: detail.routingUnitId,
      routingUnitNameAr: detail.routingUnitNameAr,
      stageCode: detail.currentStageCode,
      executionNo: 1,
      responsibleUnitId: detail.currentResponsibleUnitId ?? '',
      responsibleUnitName: detail.currentResponsibleUnitName ?? '',
      responsibleUnitKind: '',
      status: 'OPEN',
      workState: detail.currentWorkState ?? 'MANAGER_INBOX',
      openedAt: detail.createdAt,
      completedAt: null,
      // Viewer-relative assignment facts (presentation only; server revalidates):
      activeAssigneeUserId: null,
      activeAssigneeDisplayName: null,
      assignedAt: null
    }
  }, [detail, myWorkStages, user])

  if (notFound) {
    return (
      <EmptyState
        icon={Inbox}
        title="الطلب غير متاح"
        body="الطلب غير موجود أو لا تملك صلاحية الاطلاع عليه."
        action={{ to: '/requests', label: 'عودة إلى الطلبات' }}
      />
    )
  }
  if (!detail || !user) {
    return <p className="loading" role="status">جارٍ تحميل الطلب…</p>
  }

  const context = user.operationalContext
  const isHrManager = context !== null && context.unitKind === 'HR' && context.isManager
  const isManagerOfCurrentUnit = context !== null && context.isManager
    && detail.currentResponsibleUnitId !== null
    && context.unitId === detail.currentResponsibleUnitId

  const viewerIsAssignee = currentStage !== null && currentStage.activeAssigneeUserId === user.userId
  const workStateAllowsDomainEdit = detail.currentWorkState !== null
    && DOMAIN_EDITABLE_WORK_STATES.has(detail.currentWorkState)
  // Domain-data editors follow the same rule the backend enforces:
  // unit manager always; the active assignee only before submitting for review.
  const domainEditorEligible = isManagerOfCurrentUnit || (viewerIsAssignee && workStateAllowsDomainEdit)

  const canEditCandidates = viewerIsAssignee && detail.status === 'DRAFT'
    && detail.currentStageCode !== null
    && INITIAL_STAGE_CODES.has(detail.currentStageCode)

  const stageCode = detail.currentStageCode
  const isPromotion = detail.requestType === 'PROMOTION'
  const promotionEditable = stageCode === 'P4' && domainEditorEligible
  const showPromotionReadonly = isPromotion
    && (stageCode === 'P4O' || stageCode === 'P5' || detail.status === 'COMPLETED')
    || (stageCode === 'P4' && !promotionEditable && detail.status !== 'DRAFT')
  const secondmentMode: 'edit-s2' | 'edit-s3' | 'readonly' =
    stageCode === 'S2' && domainEditorEligible ? 'edit-s2'
      : stageCode === 'S3' && domainEditorEligible ? 'edit-s3'
        : 'readonly'
  const showSecondmentPanel = !isPromotion
    && ((stageCode !== null && ['S2', 'S3', 'S4', 'S5'].includes(stageCode)) || detail.status === 'COMPLETED')

  return (
    <div className="request-detail">
      <header className="card request-header">
        <div className="request-header__row">
          <h1>
            طلب {isPromotion ? 'ترقية' : 'ندب'}
            <span className="mono request-number">{detail.requestNumber}</span>
          </h1>
          <button type="button" className="icon-button" aria-label="تحديث الطلب" title="تحديث الطلب" onClick={() => setRevision(v => v + 1)}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="request-meta">
          <StatusBadge status={detail.status} />
          {stageCode && <><StageChip code={stageCode} /><span className="muted">{STAGE_LABELS[stageCode]}</span></>}
          {detail.currentIterationNo !== null && <span className="muted">التكرار رقم {detail.currentIterationNo}</span>}
          {detail.currentWorkState && (
            <>
              <StatusBadge status={detail.currentWorkState} />
              <span className="muted">{WORK_STATE_LABELS[detail.currentWorkState]}</span>
            </>
          )}
          <span className="muted">النيابة: {detail.routingUnitNameAr ?? '—'}</span>
          <span className="muted">الوحدة المسؤولة: {detail.currentResponsibleUnitName ?? '—'}</span>
          <span className="muted">أُنشئ بواسطة: {detail.createdByUserDisplayName ?? '—'} • {formatDateTime(detail.createdAt)}</span>
          {viewerIsAssignee && <span className="badge badge--info">هذه المرحلة مسندة إليك</span>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {actionError && <p className="error" role="alert">{actionError}</p>}
      </header>

      {detail.status === 'REJECTED_PENDING_HR_DECISION' && isHrManager && (
        <section className="card card--soft hr-decision" aria-label="قرار الموارد البشرية">
          <h2>{REQUEST_STATUS_LABELS[('REJECTED_PENDING_HR_DECISION') satisfies WorkflowRequestStatus]}</h2>
          <p className="muted">اختر أحد الإجراءين فقط: إعادة إنشاء التكرار التالي من البداية، أو إلغاء الطلب نهائياً.</p>
          <div className="stage-actions__group">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void runRequestAction(() => workflowApi.restartRequest(detail.id))}
            >
              إعادة الإنشاء (تكرار جديد)
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={() => void runRequestAction(() => workflowApi.cancelRequest(detail.id))}
            >
              إلغاء الطلب نهائياً
            </button>
          </div>
        </section>
      )}

      {/* Current stage commands: assign / take / submit / review / approve-or-sign. */}
      {currentStage !== null && detail.status !== 'REJECTED_PENDING_HR_DECISION' && (
        <StageActionsPanel
          stage={currentStage}
          user={user}
          onChanged={() => { void reload(); setRevision(v => v + 1) }}
        />
      )}

      {/* Promotion decisions: editable only at P4 for eligible editors; read-only evidence elsewhere. */}
      {(promotionEditable || showPromotionReadonly) && (
        <PromotionDecisionsPanel
          requestId={detail.id}
          stageExecutionId={promotionEditable ? detail.currentExecutionId : null}
          revision={revision}
          editable={promotionEditable}
        />
      )}

      {/* Secondment preparation/options/selections. */}
      {showSecondmentPanel && (
        <SecondmentStagePanel
          requestId={detail.id}
          stageExecutionId={secondmentMode === 'readonly' ? null : detail.currentExecutionId}
          candidates={detail.candidates}
          revision={revision}
          mode={secondmentMode}
        />
      )}

      <CandidatePanel
        requestId={detail.id}
        candidates={detail.candidates}
        canEdit={canEditCandidates}
        onChanged={() => { void reload(); setRevision(v => v + 1) }}
      />

      <DocumentPanel request={detail} />

      <SignoffsView signoffs={signoffs} currentIterationNo={detail.currentIterationNo} requestId={detail.id} />

      <div className="two-column">
        <NotesPanel
          requestId={detail.id}
          candidates={detail.candidates}
          revision={revision}
          canWrite
        />
        <TimelinePanel requestId={detail.id} revision={revision} />
      </div>
    </div>
  )
}

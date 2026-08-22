import type { StageCode, StageWorkState, WorkflowRequestStatus } from '../api/workflow-types'
import { REQUEST_STATUS_LABELS, STAGE_LABELS, WORK_STATE_LABELS } from '../api/workflow-types'

const STATUS_TONES: Record<string, string> = {
  DRAFT: 'badge--info',
  ACTIVE: 'badge--success',
  REJECTED_PENDING_HR_DECISION: 'badge--warning',
  COMPLETED: 'badge--neutral',
  CANCELLED: 'badge--danger',
  MANAGER_INBOX: 'badge--info',
  ASSIGNED: 'badge--info',
  IN_PROGRESS: 'badge--warning',
  MANAGER_REVIEW: 'badge--success',
  CORRECTION_REQUIRED: 'badge--danger',
  OPEN: 'badge--info'
}

export function StatusBadge({ status }: { status: WorkflowRequestStatus | StageWorkState | string }): React.JSX.Element {
  const tone = STATUS_TONES[status] ?? 'badge--neutral'
  const label = REQUEST_STATUS_LABELS[status as WorkflowRequestStatus]
    ?? WORK_STATE_LABELS[status as StageWorkState]
    ?? status
  return <span className={`badge ${tone}`}>{label}</span>
}

export function StageChip({ code }: { code: StageCode }): React.JSX.Element {
  return <span className="stage-chip mono" title={STAGE_LABELS[code]}>{code}</span>
}

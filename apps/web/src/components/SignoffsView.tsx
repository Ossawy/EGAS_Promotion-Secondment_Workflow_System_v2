import { PenTool } from 'lucide-react'
import { signatureApi } from '../api/endpoints'
import type { StageCode, WorkflowSignoffView } from '../api/workflow-types'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

/** Immutable official signer blocks built from workflow_signoff evidence. */
export function SignoffsView({
  signoffs,
  currentIterationNo,
  requestId
}: {
  signoffs: WorkflowSignoffView[]
  currentIterationNo: number | null
  requestId: string
}): React.JSX.Element | null {
  if (signoffs.length === 0) return null

  const byIteration = new Map<number, WorkflowSignoffView[]>()
  for (const signoff of signoffs) {
    const bucket = byIteration.get(signoff.iterationNo) ?? []
    bucket.push(signoff)
    byIteration.set(signoff.iterationNo, bucket)
  }
  const iterations = [...byIteration.keys()].sort((a, b) => b - a)

  return (
    <section className="card" aria-label="التأشيرات الرسمية">
      <h2><PenTool size={19} aria-hidden="true" /> التأشيرات الرسمية</h2>
      {iterations.map(iterationNo => (
        <div key={iterationNo} className="signoff-iteration">
          <h3 className={currentIterationNo !== null && iterationNo === currentIterationNo ? 'text-success' : 'muted'}>
            التكرار رقم {iterationNo}
            {currentIterationNo === iterationNo ? ' (الحالي)' : ' (سجل تاريخي)'}
          </h3>
          <div className="signoff-blocks">
            {byIteration.get(iterationNo)!.map(signoff => (
              <figure key={signoff.id} className="signoff-block">
                <figcaption>
                  <strong>{signoff.signerDisplayName}</strong>
                  <span>{signoff.signerJobTitle}{signoff.jobTitleWasOverridden ? ' (مسمى معتمد للتوقيع)' : ''}</span>
                  <span className="mono">{stageShortLabel(signoff.stageCode)} • {formatDate(signoff.signedAt)}</span>
                </figcaption>
                {signoff.signatureAssetId && (
                  <img
                    src={signatureApi.imageUrl(signoff.signatureAssetId, requestId)}
                    alt={`توقيع ${signoff.signerDisplayName}`}
                    loading="lazy"
                  />
                )}
              </figure>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function stageShortLabel(code: StageCode): string {
  return code
}

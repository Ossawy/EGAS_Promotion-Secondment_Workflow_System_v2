import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PenLine } from 'lucide-react'
import { signatureApi, workflowApi } from '../api/endpoints'
import { arabicErrorMessage } from '../api/messages'
import type { SignatureAssetView } from '../api/workflow-types'
import { PasswordConfirmationDialog } from './PasswordConfirmationDialog'

/**
 * Atomic official-signing control: fresh password reauthentication immediately
 * before a single POST /stages/:id/sign-and-advance call. The password never
 * leaves the dialog state beyond the one attempt.
 */
export function SignAndAdvanceControl({
  stageId,
  stageLabel,
  onChanged,
  onError
}: {
  stageId: string
  stageLabel?: string
  onChanged(): void
  onError(message: string): void
}): React.JSX.Element {
  const [assets, setAssets] = useState<SignatureAssetView[] | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [jobTitleOverride, setJobTitleOverride] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [signingBusy, setSigningBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const loadAssets = useCallback(async () => {
    try {
      const list = await signatureApi.mySignatures()
      setAssets(list.filter(asset => asset.isActive))
    } catch (requestError) {
      onError(arabicErrorMessage(requestError))
    }
  }, [onError])

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  async function confirmSign(password: string): Promise<void> {
    if (!selectedAssetId) return
    setSigningBusy(true)
    setDialogError(null)
    try {
      await workflowApi.signAndAdvance(stageId, {
        password,
        signatureAssetId: selectedAssetId,
        ...(jobTitleOverride.trim() ? { jobTitleOverride: jobTitleOverride.trim() } : {})
      })
      // Clear local signing state after success; password was already wiped by the dialog.
      setJobTitleOverride('')
      setDialogOpen(false)
      onChanged()
    } catch (requestError) {
      // Wrong password or stale stage: no signoff was created; allow a fresh attempt.
      setDialogError(arabicErrorMessage(requestError))
    } finally {
      setSigningBusy(false)
    }
  }

  if (assets !== null && assets.length === 0) {
    return (
      <div className="card card--soft">
        <p className="warning">لا يوجد توقيع نشط في حسابك. ارفع توقيعك أولاً لإتمام التوقيع الرسمي.</p>
        <Link className="button button--primary" to="/signature"><PenLine size={16} aria-hidden="true" /> إدارة التوقيع</Link>
      </div>
    )
  }

  return (
    <div className="sign-control card card--soft">
      <label className="field">
        اختر التوقيع المعتمد
        <select value={selectedAssetId} onChange={event => setSelectedAssetId(event.target.value)}>
          <option value="" disabled>اختر…</option>
          {(assets ?? []).map(asset => (
            <option key={asset.id} value={asset.id}>
              {asset.createdAt ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(asset.createdAt)) : 'توقيع'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        تجاوز المسمى الوظيفي للتوقيع (اختياري)
        <input
          type="text"
          value={jobTitleOverride}
          onChange={event => setJobTitleOverride(event.target.value)}
          maxLength={240}
          placeholder="يُستخدم المسمى الوظيفي المسجل افتراضياً"
        />
      </label>
      <button
        type="button"
        className="button button--primary"
        disabled={!selectedAssetId}
        onClick={() => { setDialogError(null); setDialogOpen(true) }}
      >
        <PenLine size={17} aria-hidden="true" /> اعتماد وتوقيع
      </button>

      <PasswordConfirmationDialog
        open={dialogOpen}
        busy={signingBusy}
        error={dialogError}
        contextLabel={stageLabel}
        signaturePreviewUrl={selectedAssetId ? signatureApi.imageUrl(selectedAssetId) : undefined}
        onConfirm={confirmSign}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  )
}

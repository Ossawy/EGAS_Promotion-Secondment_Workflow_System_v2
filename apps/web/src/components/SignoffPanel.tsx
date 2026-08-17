import {
  useEffect,
  useMemo,
  useState
} from 'react'
import {
  CheckCircle2,
  FileSignature,
  ShieldCheck,
  Upload
} from 'lucide-react'

import {
  ApiError,
  apiJson,
  apiRequest
} from '../api/client'
import type {
  SignatureAsset,
  WorkflowRequestDetail,
  WorkflowSignoff
} from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import {
  PasswordConfirmationDialog
} from './PasswordConfirmationDialog'

const stageRole: Record<string, string> = {
  P1: 'EMPLOYEE_AFFAIRS',
  S1: 'EMPLOYEE_AFFAIRS',
  P2: 'ORGANIZATION',
  S2: 'ORGANIZATION'
}

function formatDate(
  value: string
): string {
  return new Intl.DateTimeFormat(
    'ar-EG',
    {
      dateStyle: 'medium',
      timeStyle: 'short'
    }
  ).format(new Date(value))
}

function message(
  error: unknown
): string {
  if (error instanceof ApiError) {
    const labels: Record<string, string> = {
      SIGNATURE_MEDIA_TYPE_INVALID:
        'صيغة ملف التوقيع غير مدعومة. استخدم PNG أو JPEG.',

      SIGNATURE_FILE_SIZE_INVALID:
        'حجم ملف التوقيع يجب ألا يتجاوز 1 ميجابايت.',

      SIGNATURE_DIMENSIONS_INVALID:
        'أبعاد صورة التوقيع أكبر من الحد المسموح.',

      SIGNATURE_IMAGE_INVALID:
        'تعذر التحقق من محتوى صورة التوقيع.',

      WORKFLOW_SIGNER_JOB_TITLE_REQUIRED:
        'المسمى الوظيفي للموقّع مطلوب.',

      WORKFLOW_SIGNOFF_EXISTS:
        'تم اعتماد توقيع هذه المرحلة بالفعل.',

      SIGNATURE_PASSWORD_REQUIRED:
        'يرجى إدخال كلمة المرور لتأكيد التوقيع.',

      SIGNATURE_PASSWORD_INVALID:
        'كلمة المرور غير صحيحة. لم يتم اعتماد التوقيع.'
    }

    return (
      labels[error.code]
      ?? error.message
    )
  }

  return (
    'تعذر حفظ التوقيع. يرجى المحاولة مرة أخرى.'
  )
}

export function SignoffPanel({
  detail,
  onChanged
}: {
  detail: WorkflowRequestDetail
  onChanged(): Promise<void>
}): React.JSX.Element {
  const { user } = useAuth()

  const [
    signoffs,
    setSignoffs
  ] = useState<WorkflowSignoff[]>([])

  const [
    file,
    setFile
  ] = useState<File | null>(null)

  const [
    jobTitle,
    setJobTitle
  ] = useState(
    user?.jobTitle ?? ''
  )

  const [
    preview,
    setPreview
  ] = useState<string | null>(null)

  const [
    busy,
    setBusy
  ] = useState(false)

  const [
    error,
    setError
  ] = useState<string | null>(null)

  const [
    passwordDialogOpen,
    setPasswordDialogOpen
  ] = useState(false)

  const [
    passwordDialogError,
    setPasswordDialogError
  ] = useState<string | null>(null)

  const load =
    async (): Promise<void> => {
      setSignoffs(
        await apiRequest<
          WorkflowSignoff[]
        >(
          `/api/workflow/requests/${detail.id}/signoffs`
        )
      )
    }

  useEffect(
    () => {
      void load().catch(
        caught =>
          setError(
            message(caught)
          )
      )
    },
    [detail.id]
  )

  useEffect(
    () => {
      if (!file) {
        setPreview(null)
        return
      }

      const url =
        URL.createObjectURL(file)

      setPreview(url)

      return () =>
        URL.revokeObjectURL(url)
    },
    [file]
  )

  const currentSignoff =
    useMemo(
      () =>
        signoffs.find(
          item =>
            item.iterationNo ===
              detail.currentIterationNo
            &&
            item.stageCode ===
              detail.currentStage
        ),
      [
        detail.currentIterationNo,
        detail.currentStage,
        signoffs
      ]
    )

  const canSign =
    detail.actionable
    &&
    stageRole[
      detail.currentStage
    ] === user?.activeRole
    &&
    !currentSignoff

  function selectFile(
    selected: File | undefined
  ): void {
    setError(null)

    if (!selected) {
      setFile(null)
      return
    }

    if (
      ![
        'image/png',
        'image/jpeg'
      ].includes(selected.type)
    ) {
      setFile(null)

      setError(
        'اختر صورة PNG أو JPEG فقط.'
      )

      return
    }

    if (
      selected.size >
      1_048_576
    ) {
      setFile(null)

      setError(
        'حجم ملف التوقيع يجب ألا يتجاوز 1 ميجابايت.'
      )

      return
    }

    setFile(selected)
  }

  /*
   * The normal sign button no longer
   * performs any network request.
   *
   * It only opens the reauthentication
   * dialog.
   */
  function requestSignature(
    event: React.FormEvent
  ): void {
    event.preventDefault()

    if (
      busy
      ||
      !file
      ||
      !jobTitle.trim()
    ) {
      return
    }

    setError(null)
    setPasswordDialogError(null)
    setPasswordDialogOpen(true)
  }

  /*
   * Only this function receives the
   * password from the dialog.
   *
   * The password exists only for this
   * single signing attempt.
   */
  async function confirmSignature(
    password: string
  ): Promise<void> {
    if (
      busy
      ||
      !file
      ||
      !jobTitle.trim()
    ) {
      return
    }

    setBusy(true)
    setError(null)
    setPasswordDialogError(null)

    try {
      /*
       * Uploading the image itself is
       * not an immutable workflow signoff.
       *
       * The immutable signoff is created
       * only by the following POST, which
       * includes the freshly entered
       * password.
       */
      const asset =
        await apiRequest<
          SignatureAsset
        >(
          '/api/workflow/signatures',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                file.type
            },
            body: file
          }
        )

      await apiJson<
        WorkflowSignoff
      >(
        `/api/workflow/requests/${detail.id}/signoff`,
        'POST',
        {
          signatureAssetId:
            asset.id,

          jobTitle:
            jobTitle.trim(),

          /*
           * IMPORTANT:
           * Never trim, normalize,
           * persist, or log this value.
           */
          password
        }
      )

      setPasswordDialogOpen(false)
      setPasswordDialogError(null)
      setFile(null)

      await Promise.all([
        load(),
        onChanged()
      ])
    } catch (caught) {
      /*
       * Wrong password has a specific
       * Arabic message required by the
       * workflow UX.
       *
       * Keep the dialog open so the user
       * can retry. The dialog component
       * itself has already cleared its
       * password field.
       */
      if (
        caught instanceof ApiError
        &&
        caught.code ===
          'SIGNATURE_PASSWORD_INVALID'
      ) {
        setPasswordDialogError(
          'كلمة المرور غير صحيحة. لم يتم اعتماد التوقيع.'
        )

        return
      }

      /*
       * Other failures are also displayed
       * inside the dialog because the
       * dialog remains the active context
       * for this signing attempt.
       */
      setPasswordDialogError(
        message(caught)
      )
    } finally {
      setBusy(false)
    }
  }

  function cancelSignature(): void {
    if (busy) return

    setPasswordDialogError(null)
    setPasswordDialogOpen(false)
  }

  if (
    !canSign
    &&
    signoffs.length === 0
    &&
    !stageRole[
      detail.currentStage
    ]
  ) {
    return <></>
  }

  return (
    <>
      <section
        className="panel signoff-panel"
      >
        <div className="panel__header">
          <div>
            <h2>
              التوقيعات الرسمية
            </h2>

            <p>
              توقيع شئون العاملين في P1/S1
              وتوقيع التنظيم في P2/S2 أدلة
              ثابتة لا تُستبدل.
            </p>
          </div>

          <FileSignature
            size={23}
          />
        </div>

        {error && (
          <p
            className="error"
            role="alert"
          >
            {error}
          </p>
        )}

        {canSign && (
          <form
            className="signoff-form"
            onSubmit={
              requestSignature
            }
          >
            <div className="signoff-identity">
              <ShieldCheck />

              <span>
                <small>
                  اسم الموقّع من الحساب
                </small>

                <strong>
                  {user?.displayName}
                </strong>
              </span>
            </div>

            <label>
              المسمى الوظيفي لهذا التوقيع

              <input
                value={jobTitle}
                onChange={
                  event =>
                    setJobTitle(
                      event.target.value
                    )
                }
                maxLength={500}
                required
              />
            </label>

            <label className="signature-upload">
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={
                  event =>
                    selectFile(
                      event.target
                        .files?.[0]
                    )
                }
              />

              {preview
                ? (
                  <img
                    src={preview}
                    alt="معاينة التوقيع قبل الاعتماد"
                  />
                )
                : (
                  <span>
                    <Upload
                      size={24}
                    />

                    <strong>
                      اختر صورة التوقيع
                    </strong>

                    <small>
                      PNG أو JPEG · بحد أقصى 1MB
                    </small>
                  </span>
                )}
            </label>

            <button
              type="submit"
              className="button button--primary"
              disabled={
                busy
                ||
                !file
                ||
                !jobTitle.trim()
              }
            >
              اعتماد توقيع المرحلة
            </button>
          </form>
        )}

        {currentSignoff && (
          <p className="signoff-complete">
            <CheckCircle2
              size={19}
            />

            تم اعتماد توقيع هذه المرحلة
            ويمكن الآن متابعة الإرسال.
          </p>
        )}

        {signoffs.length > 0 && (
          <div className="signoff-list">
            {signoffs.map(
              signoff => (
                <article
                  key={signoff.id}
                >
                  <img
                    src={
                      `/api/workflow/signatures/${signoff.signatureAssetId}/content`
                    }
                    alt={
                      `توقيع ${signoff.signerName}`
                    }
                  />

                  <div>
                    <strong>
                      {signoff.signerName}
                    </strong>

                    <span>
                      {signoff.signerJobTitle}
                    </span>

                    <small>
                      المرحلة{' '}
                      {signoff.stageCode}
                      {' · '}
                      الدورة{' '}
                      {signoff.iterationNo}
                      {' · '}
                      {formatDate(
                        signoff.signedAt
                      )}
                    </small>
                  </div>

                  <CheckCircle2
                    size={20}
                  />
                </article>
              )
            )}
          </div>
        )}
      </section>

      <PasswordConfirmationDialog
        open={
          passwordDialogOpen
        }
        busy={busy}
        error={
          passwordDialogError
        }
        onConfirm={
          confirmSignature
        }
        onCancel={
          cancelSignature
        }
      />
    </>
  )
}
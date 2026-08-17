import {
  useEffect,
  useRef,
  useState
} from 'react'
import {
  KeyRound,
  ShieldCheck
} from 'lucide-react'

export function PasswordConfirmationDialog({
  open,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  open: boolean
  busy: boolean
  error: string | null
  onConfirm(password: string): Promise<void>
  onCancel(): void
}): React.JSX.Element | null {
  const [password, setPassword] =
    useState('')

  const inputRef =
    useRef<HTMLInputElement>(null)

  const submittingRef =
    useRef(false)

  useEffect(() => {
    if (!open) {
      setPassword('')
      submittingRef.current = false
      return
    }

    setPassword('')

    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }, [open])

  useEffect(() => {
    if (!open) return

    function handleKeyDown(
      event: KeyboardEvent
    ): void {
      if (
        event.key === 'Escape' &&
        !busy &&
        !submittingRef.current
      ) {
        setPassword('')
        onCancel()
      }
    }

    window.addEventListener(
      'keydown',
      handleKeyDown
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown
      )
    }
  }, [open, busy, onCancel])

  if (!open) return null

  async function submit(
    event: React.FormEvent
  ): Promise<void> {
    event.preventDefault()

    if (
      busy ||
      submittingRef.current ||
      password.length === 0
    ) {
      return
    }

    submittingRef.current = true

    const submittedPassword =
      password

    /*
     * Remove the password from component state
     * immediately after taking the value needed for
     * this single request.
     */
    setPassword('')

    try {
      await onConfirm(
        submittedPassword
      )
    } finally {
      /*
       * Never retain a reusable password in the
       * component after success or failure.
       */
      setPassword('')
      submittingRef.current = false
    }
  }

  function cancel(): void {
    if (
      busy ||
      submittingRef.current
    ) {
      return
    }

    setPassword('')
    onCancel()
  }

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
    >
      <section
        className="password-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signature-password-title"
        aria-describedby="signature-password-description"
        dir="rtl"
      >
        <div className="password-dialog__icon">
          <ShieldCheck
            size={28}
            aria-hidden="true"
          />
        </div>

        <div className="password-dialog__heading">
          <h2
            id="signature-password-title"
          >
            تأكيد الهوية قبل التوقيع
          </h2>

          <p
            id="signature-password-description"
          >
            أدخل كلمة مرور حسابك لتأكيد هذا التوقيع.
          </p>
        </div>

        <form
          className="password-dialog__form"
          onSubmit={
            event =>
              void submit(event)
          }
        >
          {error && (
            <p
              className="error"
              role="alert"
            >
              {error}
            </p>
          )}

          <label>
            كلمة المرور

            <span className="password-dialog__input">
              <KeyRound
                size={19}
                aria-hidden="true"
              />

              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={
                  event =>
                    setPassword(
                      event.target.value
                    )
                }
                autoComplete="current-password"
                maxLength={256}
                disabled={busy}
                required
                aria-invalid={
                  error
                    ? true
                    : undefined
                }
              />
            </span>
          </label>

          <div className="password-dialog__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={cancel}
              disabled={busy}
            >
              إلغاء
            </button>

            <button
              type="submit"
              className="button button--primary"
              disabled={
                busy ||
                password.length === 0
              }
            >
              {busy
                ? 'جارٍ التحقق...'
                : 'تأكيد والتوقيع'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
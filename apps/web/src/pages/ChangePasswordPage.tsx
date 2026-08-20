import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthLayout } from '../components/AuthLayout'

export function ChangePasswordPage(): React.JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!auth.loading && !auth.user) return <Navigate to="/login" replace />

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (newPassword !== confirmPassword) {
      setLocalError('كلمتا المرور الجديدتان غير متطابقتين.')
      return
    }
    setLocalError(null)
    setSubmitting(true)
    try {
      const user = await auth.changePassword(currentPassword, newPassword)
      navigate('/', { replace: true })
    } catch {
      // The provider exposes the safe API error.
    } finally {
      setSubmitting(false)
    }
  }

  return <AuthLayout title="تغيير كلمة المرور" subtitle="يجب تغيير كلمة المرور المؤقتة قبل متابعة العمل">
    <form className="auth-form" onSubmit={submit} aria-label="تغيير كلمة المرور">
      <label>كلمة المرور الحالية
        <span className="input-shell"><input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /></span>
      </label>
      <label>كلمة المرور الجديدة
        <span className="input-shell"><input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={8} maxLength={256} required /></span>
      </label>
      <label>تأكيد كلمة المرور الجديدة
        <span className="input-shell"><input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={8} maxLength={256} required /></span>
      </label>
      {(localError || auth.error) && <p className="error" role="alert">{localError ?? auth.error}</p>}
      <button className="button button--primary auth-form__submit" type="submit" disabled={submitting}>{submitting ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}</button>
    </form>
  </AuthLayout>
}

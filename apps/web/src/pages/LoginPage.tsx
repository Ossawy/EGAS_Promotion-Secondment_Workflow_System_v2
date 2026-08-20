import { Eye, EyeOff, LockKeyhole, LogIn, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthLayout } from '../components/AuthLayout'

export function LoginPage(): React.JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const isAdmin = location.pathname.startsWith('/admin')

  if (auth.user) {
    if (auth.user.mustChangePassword) return <Navigate to="/change-password" replace />
    return <Navigate to="/" replace />
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    try {
      const user = await auth.login(username, password)
      navigate(user.mustChangePassword ? '/change-password' : '/', { replace: true })
    } catch {
      // The provider exposes the safe API error next to the form.
    } finally {
      setSubmitting(false)
    }
  }

  return <AuthLayout title="مرحباً بك مجدداً" subtitle="الرجاء إدخال بياناتك لتسجيل الدخول" eyebrow={isAdmin ? 'بوابة إدارة النظام' : 'بوابة مسارات العمل'}>
    <form className="auth-form" onSubmit={submit} aria-label="تسجيل الدخول">
      <label>اسم المستخدم / الرقم الوظيفي
        <span className="input-shell"><UserRound aria-hidden="true" /><input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required placeholder="أدخل اسم المستخدم" /></span>
      </label>
      <label>كلمة المرور
        <span className="input-shell"><LockKeyhole aria-hidden="true" /><input autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} required placeholder="أدخل كلمة المرور" />
          <button className="input-shell__action" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}>{showPassword ? <EyeOff /> : <Eye />}</button>
        </span>
      </label>
      {auth.error && <p className="error" role="alert">{auth.error}</p>}
      <button className="button button--primary auth-form__submit" type="submit" disabled={submitting}><LogIn size={20} />{submitting ? 'جارٍ تسجيل الدخول...' : 'تسجيل الدخول'}</button>
      <p className="auth-form__help">في حال تعذر الدخول، تواصل مع مسئول النظام لإعادة تعيين كلمة المرور.</p>
    </form>
  </AuthLayout>
}

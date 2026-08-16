import { Navigate, useNavigate } from 'react-router-dom'
import type { Role } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { AuthLayout } from '../components/AuthLayout'

const roleLabels: Record<Role, string> = {
  ADMIN: 'إدارة النظام',
  EMPLOYEE_AFFAIRS: 'شئون العاملين',
  ORGANIZATION: 'إدارة التنظيم',
  APPROVING_AUTHORITY: 'سلطة الاعتماد'
}

export function RoleSelectionPage(): React.JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()

  if (!auth.loading && !auth.user) return <Navigate to="/login" replace />
  if (auth.user?.mustChangePassword) return <Navigate to="/change-password" replace />

  async function select(role: Role): Promise<void> {
    try {
      await auth.selectRole(role)
      navigate('/', { replace: true })
    } catch {
      // The provider exposes the safe API error.
    }
  }

  return <AuthLayout title="اختر الدور النشط" subtitle="سيتم تطبيق صلاحيات دور واحد فقط خلال هذه الجلسة">
    <section className="role-list" aria-label="الأدوار المتاحة">
      <div className="role-list">
        {auth.user?.availableRoles.map(assignment =>
          <button className="button button--secondary" key={assignment.role} type="button" onClick={() => void select(assignment.role)}>
            {roleLabels[assignment.role]}
          </button>
        )}
      </div>
      {auth.error && <p className="error" role="alert">{auth.error}</p>}
    </section>
  </AuthLayout>
}

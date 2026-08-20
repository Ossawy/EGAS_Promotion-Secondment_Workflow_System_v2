import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AuthGate } from './auth/AuthGate'
import { RequireRole } from './auth/RequireRole'
import { AppShell } from './layout/AppShell'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { NewRequestPage } from './pages/NewRequestPage'
import { RequestDetailPage } from './pages/RequestDetailPage'
import { RoleSelectionPage } from './pages/RoleSelectionPage'
import { HistoryPage } from './pages/HistoryPage'
import { AdminAuditPage } from './pages/admin/AdminAuditPage'
import { AdminAuthoritiesPage } from './pages/admin/AdminAuthoritiesPage'
import { AdminDatasetPage } from './pages/admin/AdminDatasetPage'
import { AdminUsersPage } from './pages/admin/AdminUsersPage'

export function App(): React.JSX.Element {
  return <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin/login" element={<LoginPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AuthGate />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="requests" element={<DashboardPage />} />
            <Route element={<RequireRole role="EMPLOYEE_AFFAIRS" />}>
              <Route path="requests/new" element={<NewRequestPage />} />
            </Route>
            <Route path="requests/:id" element={<RequestDetailPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route element={<RequireRole role="ADMIN" />}>
              <Route path="admin/users" element={<AdminUsersPage />} />
              <Route path="admin/authorities" element={<AdminAuthoritiesPage />} />
              <Route path="admin/dataset" element={<AdminDatasetPage />} />
              <Route path="admin/audit" element={<AdminAuditPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  </BrowserRouter>
}

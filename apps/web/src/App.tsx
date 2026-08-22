import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AuthGate } from './auth/AuthGate'
import { RequireAdmin, RequireHrOperational, RequireOperational, RequireOperationalManager } from './auth/guards'
import { AppShell } from './layout/AppShell'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { ManagerInboxPage } from './pages/ManagerInboxPage'
import { MyWorkPage } from './pages/MyWorkPage'
import { NewRequestPage } from './pages/NewRequestPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { RequestDetailPage } from './pages/RequestDetailPage'
import { RequestsPage } from './pages/RequestsPage'
import { SignatureSettingsPage } from './pages/SignatureSettingsPage'
import { AdminAccountsPage } from './pages/admin/AdminAccountsPage'
import { AdminAuditPage } from './pages/admin/AdminAuditPage'
import { AdminUnitsPage } from './pages/admin/AdminUnitsPage'

export function App(): React.JSX.Element {
  return <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AuthGate />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            {/* Operational manager workspaces */}
            <Route element={<RequireOperationalManager />}>
              <Route path="inbox" element={<ManagerInboxPage />} />
            </Route>
            {/* HR operational request preparation */}
            <Route element={<RequireHrOperational />}>
              <Route path="requests/new" element={<NewRequestPage />} />
            </Route>
            {/* Generic operational workspaces; the server independently enforces object access. */}
            <Route element={<RequireOperational />}>
              <Route path="my-work" element={<MyWorkPage />} />
              <Route path="signature" element={<SignatureSettingsPage />} />
              <Route path="requests" element={<RequestsPage />} />
              <Route path="requests/:id" element={<RequestDetailPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
            </Route>
            {/* Admin workspace */}
            <Route element={<RequireAdmin />}>
              <Route path="admin/accounts" element={<AdminAccountsPage />} />
              <Route path="admin/audit" element={<AdminAuditPage />} />
              <Route path="admin/units" element={<AdminUnitsPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  </BrowserRouter>
}

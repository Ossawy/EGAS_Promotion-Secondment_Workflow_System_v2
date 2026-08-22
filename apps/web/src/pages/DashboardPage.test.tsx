import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApi, workflowApi } from '../api/endpoints'
import type { UserContext } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { DashboardPage } from './DashboardPage'

vi.mock('../auth/AuthProvider', async original => ({ ...(await original<typeof import('../auth/AuthProvider')>()), useAuth: vi.fn() }))
vi.mock('../api/endpoints', async original => {
  const actual = await original<typeof import('../api/endpoints')>()
  return { ...actual, adminApi: { ...actual.adminApi, dashboard: vi.fn() }, workflowApi: { ...actual.workflowApi, myWork: vi.fn(), managerInbox: vi.fn(), listRequests: vi.fn(), notifications: vi.fn() } }
})

function user(unitKind: 'HR' | 'ORG', isManager = false): UserContext {
  return { userId: 'u1', username: 'user', staffIdentifier: null, displayName: 'مستخدم', jobTitle: null, accountType: 'OPERATIONAL', mustChangePassword: false, operationalContext: { membershipId: 'm1', unitId: `${unitKind}-unit`, unitKind, routingUnitId: null, routingUnitName: null, isManager, managerAssignmentId: isManager ? 'ma1' : null } }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('role-aware dashboard', () => {
  it('shows Create Request for an HR employee and hides it from a non-HR employee', async () => {
    const auth = { loading: false, error: null, login: vi.fn(), changePassword: vi.fn(), logout: vi.fn(), clearError: vi.fn() }
    vi.mocked(workflowApi.myWork).mockResolvedValue([]); vi.mocked(workflowApi.listRequests).mockResolvedValue([]); vi.mocked(workflowApi.notifications).mockResolvedValue([])
    vi.mocked(useAuth).mockReturnValue({ ...auth, user: user('HR') } as never)
    const first = render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('طلب جديد')).toBeInTheDocument()
    first.unmount()
    vi.mocked(useAuth).mockReturnValue({ ...auth, user: user('ORG') } as never)
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    await waitFor(() => expect(workflowApi.myWork).toHaveBeenCalled())
    expect(screen.queryByText('طلب جديد')).not.toBeInTheDocument()
  })

  it('renders manager inbox metrics and understandable unit labels', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: user('ORG', true), loading: false, error: null, login: vi.fn(), changePassword: vi.fn(), logout: vi.fn(), clearError: vi.fn() } as never)
    vi.mocked(workflowApi.myWork).mockResolvedValue([]); vi.mocked(workflowApi.listRequests).mockResolvedValue([]); vi.mocked(workflowApi.notifications).mockResolvedValue([])
    vi.mocked(workflowApi.managerInbox).mockResolvedValue({ stages: [], rejectedRequests: [] })
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('بانتظار الإسناد')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'لوحة متابعة التنظيم' })).toBeInTheDocument()
  })

  it('renders current-v5 admin metrics and business-facing account terminology', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { ...user('HR'), accountType: 'ADMIN', operationalContext: null }, loading: false, error: null, login: vi.fn(), changePassword: vi.fn(), logout: vi.fn(), clearError: vi.fn() } as never)
    vi.mocked(adminApi.dashboard).mockResolvedValue({ accounts: { total: 3, active: 2, inactive: 1, locked: 0 }, operationalUnits: { total: 3, HR: 1, ORG: 1, AUTH: 1 }, activeSnapshot: null, recentActivity: [], notifications: { unread: 0, recent: [] } })
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    expect(await screen.findByText('2 حساب نشط')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'لوحة الإدارة' })).toBeInTheDocument()
    expect(screen.getByText(/السلطة المختصة/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'عرض سجل التدقيق' })).toHaveAttribute('href', '/admin/audit')
    expect(screen.queryByText(/البيانات السنوية/)).not.toBeInTheDocument()
  })
})

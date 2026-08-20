import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import type { UserContext } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { DashboardPage } from './DashboardPage'

vi.mock('../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, apiRequest: vi.fn() }
})

vi.mock('../auth/AuthProvider', () => ({ useAuth: vi.fn() }))

function context(activeRole: UserContext['activeRole']): UserContext {
  return {
    userId: 'user-1', username: 'tester', staffIdentifier: 'EG-1', displayName: 'مستخدم اختبار',
    jobTitle: null, mustChangePassword: false, isActive: true, activeRole,
    availableRoles: activeRole ? [{ role: activeRole, canManageAdmins: false }] : []
  }
}

function auth(activeRole: UserContext['activeRole']): ReturnType<typeof useAuth> {
  return {
    user: context(activeRole), loading: false, error: null,
    login: vi.fn(), changePassword: vi.fn(), selectRole: vi.fn(), logout: vi.fn(), clearError: vi.fn()
  }
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
  vi.mocked(useAuth).mockReset()
})

afterEach(cleanup)

describe('role dashboards', () => {
  it('shows truthful Employee Affairs empty and unavailable-snapshot states', async () => {
    vi.mocked(useAuth).mockReturnValue(auth('EMPLOYEE_AFFAIRS'))
    vi.mocked(apiRequest).mockImplementation(path => {
      if (String(path).includes('/workflow/requests')) return Promise.resolve([])
      return Promise.reject(new Error('no active snapshot'))
    })

    render(<MemoryRouter><DashboardPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('لا توجد لقطة سنوية نشطة')).toBeInTheDocument())
    expect(screen.getByText('لا توجد طلبات')).toBeInTheDocument()
    expect(screen.getByText('مسوداتي').parentElement).toHaveTextContent('0')
  })

  it('loads the authority dashboard only from the scoped authority queue', async () => {
    vi.mocked(useAuth).mockReturnValue(auth('APPROVING_AUTHORITY'))
    vi.mocked(apiRequest).mockResolvedValue([])
    render(<MemoryRouter><DashboardPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('الطلبات بانتظار الإجراء')).toBeInTheDocument())
    expect(apiRequest).toHaveBeenCalledWith('/api/workflow/authority/queue?top=100')
    expect(screen.getByText('لا توجد طلبات')).toBeInTheDocument()
  })
})

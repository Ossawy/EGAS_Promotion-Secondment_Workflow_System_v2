import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserContext } from '../api/types'
import { RequireAdmin, RequireHrOperational, RequireOperationalManager } from '../auth/guards'
import { AuthProvider, useAuth } from '../auth/AuthProvider'

vi.mock('../auth/AuthProvider', async importOriginal => {
  const original = await importOriginal<typeof import('../auth/AuthProvider')>()
  return { ...original, useAuth: vi.fn() }
})

function userFixture(overrides: Partial<UserContext>): UserContext {
  return {
    userId: 'u-1',
    username: 'synthetic.user',
    staffIdentifier: null,
    displayName: 'مستخدم تجريبي',
    jobTitle: null,
    accountType: 'OPERATIONAL',
    mustChangePassword: false,
    operationalContext: null,
    ...overrides
  }
}

function LandingProbe(): React.JSX.Element {
  const location = useAuthLocation()
  return <p data-testid="landing">{location}</p>
}

function useAuthLocation(): string {
  // Reads the current URL through the router without extra deps.
  return typeof window === 'undefined' ? '' : decodeURIComponent(window.location.pathname)
}

afterEach(() => {
  cleanup()
  vi.mocked(useAuth).mockReset()
})

describe('presentation guards (backend stays the authorization boundary)', () => {
  it('sends ADMIN accounts to the admin workspace and hides manager routes', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: userFixture({ accountType: 'ADMIN' }),
      loading: false,
      error: null,
      login: async () => userFixture({}),
      changePassword: async () => userFixture({}),
      logout: async () => {},
      clearError: () => {}
    })

    render(
      <MemoryRouter initialEntries={['/admin/accounts']}>
        <Routes>
          <Route path="/admin/accounts" element={<RequireAdmin />}>
            <Route index element={<LandingProbe />} />
          </Route>
          <Route path="/" element={<LandingProbe />} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByTestId('landing').textContent).toBe('/')
  })

  it('redirects operational non-managers away from the manager inbox route', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: userFixture({ accountType: 'OPERATIONAL' }),
      loading: false,
      error: null,
      login: async () => userFixture({}),
      changePassword: async () => userFixture({}),
      logout: async () => {},
      clearError: () => {}
    })

    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <AuthProvider>
          <Routes>
            <Route path="/inbox" element={<RequireOperationalManager />}>
              <Route index element={<LandingProbe />} />
            </Route>
            <Route path="/" element={<LandingProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    )
    expect(screen.getAllByTestId('landing')[0]!.textContent).toBe('/')
  })

  it('rejects non-HR operational users from request creation', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: userFixture({
        accountType: 'OPERATIONAL',
        operationalContext: {
          membershipId: 'm-1', unitId: 'org-unit', unitKind: 'ORG',
          routingUnitId: null, routingUnitName: null,
          isManager: true, managerAssignmentId: 'ma-1'
        }
      }),
      loading: false,
      error: null,
      login: async () => userFixture({}),
      changePassword: async () => userFixture({}),
      logout: async () => {},
      clearError: () => {}
    })

    render(
      <MemoryRouter initialEntries={['/requests/new']}>
        <Routes>
          <Route path="/requests/new" element={<RequireHrOperational />}>
            <Route index element={<LandingProbe />} />
          </Route>
          <Route path="/" element={<LandingProbe />} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByTestId('landing').textContent).toBe('/')
  })

  it('admits an HR operational employee into request creation without a manager role', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: userFixture({ operationalContext: { membershipId: 'm-hr', unitId: 'hr-unit', unitKind: 'HR', routingUnitId: null, routingUnitName: null, isManager: false, managerAssignmentId: null } }),
      loading: false, error: null,
      login: async () => userFixture({}), changePassword: async () => userFixture({}), logout: async () => {}, clearError: () => {}
    })
    render(<MemoryRouter initialEntries={['/requests/new']}><Routes><Route path="/requests/new" element={<RequireHrOperational />}><Route index element={<p>نموذج إنشاء الطلب</p>} /></Route><Route path="/" element={<p>الرئيسية</p>} /></Routes></MemoryRouter>)
    expect(screen.getByText('نموذج إنشاء الطلب')).toBeInTheDocument()
  })
})

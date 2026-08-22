import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApi, referenceApi } from '../../api/endpoints'
import type { AdminAccount } from '../../api/admin-types'
import { AdminAccountsPage } from './AdminAccountsPage'

vi.mock('../../api/endpoints', async original => {
  const actual = await original<typeof import('../../api/endpoints')>()
  return { ...actual, adminApi: { ...actual.adminApi, accounts: vi.fn(), units: vi.fn(), updateAccount: vi.fn() }, referenceApi: { ...actual.referenceApi, routingUnits: vi.fn() } }
})
const oldAccount: AdminAccount = { id: 'u1', username: 'employee', staffIdentifier: 'E1', displayName: 'الاسم القديم', jobTitle: 'المسمى القديم', accountType: 'OPERATIONAL', mustChangePassword: false, isActive: true, lockedUntil: null, version: 1 }

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Admin account profile editing', () => {
  it('preloads, saves, and immediately renders updated current values', async () => {
    const updated = { ...oldAccount, displayName: 'الاسم الجديد', jobTitle: 'المسمى الجديد', version: 2 }
    vi.mocked(adminApi.accounts).mockResolvedValueOnce([oldAccount]).mockResolvedValue([updated])
    vi.mocked(adminApi.units).mockResolvedValue([]); vi.mocked(referenceApi.routingUnits).mockResolvedValue([]); vi.mocked(adminApi.updateAccount).mockResolvedValue(updated)
    render(<AdminAccountsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /تعديل بيانات الحساب/ }))
    const dialog = await screen.findByRole('dialog')
    const inputs = dialog.querySelectorAll('input')
    expect(inputs[0]).toHaveValue('الاسم القديم'); expect(inputs[1]).toHaveValue('المسمى القديم')
    fireEvent.change(inputs[0]!, { target: { value: 'الاسم الجديد' } }); fireEvent.change(inputs[1]!, { target: { value: 'المسمى الجديد' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التعديلات' }))
    await waitFor(() => expect(adminApi.updateAccount).toHaveBeenCalledWith('u1', { staffIdentifier: 'E1', displayName: 'الاسم الجديد', jobTitle: 'المسمى الجديد' }))
    expect(await screen.findByText('الاسم الجديد')).toBeInTheDocument()
    expect(screen.getByText('تشغيلي — يشارك في مسار العمل')).toBeInTheDocument()
  })
})

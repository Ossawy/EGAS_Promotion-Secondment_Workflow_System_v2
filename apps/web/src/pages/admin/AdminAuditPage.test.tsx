import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApi } from '../../api/endpoints'
import { AdminAuditPage } from './AdminAuditPage'

vi.mock('../../api/endpoints', async original => {
  const actual = await original<typeof import('../../api/endpoints')>()
  return { ...actual, adminApi: { ...actual.adminApi, audit: vi.fn() } }
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

const event = { id: 'e1', actorUserId: '00000000-0000-4000-8000-000000000001', eventType: 'ACCOUNT_UPDATED', subjectType: 'user_account', subjectId: 'u1', actorDisplayName: 'مدير النظام', actorUsername: 'admin.local', actorJobTitle: 'مدير النظام', actorUnitName: null, subjectLabel: 'موظف تجريبي', requestNumber: null, details: { changedFields: ['displayName'] }, createdAt: '2026-08-22T10:00:00.000Z' }

describe('AdminAuditPage', () => {
  it('renders current v5 audit events without exposing sensitive values', async () => {
    vi.mocked(adminApi.audit).mockResolvedValue({
      items: [event],
      total: 1, skip: 0, top: 25
    })
    render(<MemoryRouter><AdminAuditPage /></MemoryRouter>)
    expect(await screen.findByText('تعديل بيانات حساب')).toBeInTheDocument()
    expect(screen.getAllByText('مدير النظام').length).toBeGreaterThan(0)
    expect(screen.getByText('موظف تجريبي')).toBeInTheDocument()
    expect(screen.getByText(/تم تعديل: الاسم المعروض/)).toBeInTheDocument()
    expect(screen.queryByText('ACCOUNT_UPDATED')).not.toBeInTheDocument()
    expect(screen.queryByText('user_account')).not.toBeInTheDocument()
    expect(screen.queryByText('u1')).not.toBeInTheDocument()
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument()
  })

  it('keeps print filters hidden until requested and prints a filtered readable report', async () => {
    const print = vi.fn()
    Object.defineProperty(window, 'print', { configurable: true, value: print })
    vi.mocked(adminApi.audit)
      .mockResolvedValueOnce({ items: [event], total: 1, skip: 0, top: 25 })
      .mockResolvedValueOnce({ items: [event], total: 101, skip: 0, top: 100 })
    render(<MemoryRouter><AdminAuditPage /></MemoryRouter>)
    await screen.findByText('تعديل بيانات حساب')
    expect(screen.queryByLabelText('خيارات طباعة سجل التدقيق')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /طباعة \/ تصدير PDF/ }))
    expect(screen.getByLabelText('خيارات طباعة سجل التدقيق')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'طباعة التقرير' }))
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1))
    expect(adminApi.audit).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, top: 100 }))
    expect(screen.getAllByText('تنبيه: التقرير مقتطع').length).toBeGreaterThan(0)
    expect(screen.getByText(/يعرض التقرير 1 حدثاً من أصل 101/)).toBeInTheDocument()
  })
})

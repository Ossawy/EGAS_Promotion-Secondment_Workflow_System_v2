import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiJson, apiRequest } from '../api/client'
import type { WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { SignoffPanel } from './SignoffPanel'

vi.mock('../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, apiJson: vi.fn(), apiRequest: vi.fn() }
})
vi.mock('../auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const detail = {
  id: 'request-1', requestNumber: 'request-1', requestType: 'PROMOTION', cycleYear: 2026,
  formMonth: 8, formYear: 2026, status: 'DRAFT', currentStage: 'P1', currentIterationNo: 1,
  routingUnit: null, approvingAuthority: null,
  createdBy: { id: 'ea-1', username: 'ea', displayName: 'شئون العاملين' }, candidateCount: 0,
  createdAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-16T10:00:00.000Z', version: 1,
  editable: true, actionable: true, candidates: []
} satisfies WorkflowRequestDetail

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
  vi.mocked(apiJson).mockReset()
  vi.mocked(useAuth).mockReturnValue({ user: {
    userId: 'ea-1', username: 'ea', staffIdentifier: '1', displayName: 'الموقّع الرسمي',
    jobTitle: 'باحث شئون عاملين', mustChangePassword: false, isActive: true,
    activeRole: 'EMPLOYEE_AFFAIRS', availableRoles: [{ role: 'EMPLOYEE_AFFAIRS', canManageAdmins: false }]
  } } as ReturnType<typeof useAuth>)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(cleanup)

describe('mandatory signoff panel', () => {
  it('uploads the raw approved image and submits only the server asset identity and stage title', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'asset-1', mimeType: 'image/png', fileSizeBytes: 10, widthPx: 10, heightPx: 5, fileSha256: 'a'.repeat(64), uploadedAt: '2026-08-16T10:00:00.000Z' })
      .mockResolvedValueOnce([])
    vi.mocked(apiJson).mockResolvedValue({})
    const changed = vi.fn().mockResolvedValue(undefined)
    render(<SignoffPanel detail={detail} onChanged={changed} />)

    expect(await screen.findByDisplayValue('باحث شئون عاملين')).toBeInTheDocument()
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'signature.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/اختر صورة التوقيع/), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد توقيع المرحلة' }))

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/workflow/signatures', expect.objectContaining({
      method: 'POST', body: file, headers: { 'Content-Type': 'image/png' }
    })))
    expect(apiJson).toHaveBeenCalledWith('/api/workflow/requests/request-1/signoff', 'POST', {
      signatureAssetId: 'asset-1', jobTitle: 'باحث شئون عاملين'
    })
    expect(changed).toHaveBeenCalled()
  })
})

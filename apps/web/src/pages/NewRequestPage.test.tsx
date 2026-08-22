import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { referenceApi, workflowApi } from '../api/endpoints'
import { NewRequestPage } from './NewRequestPage'

const navigate = vi.fn()

vi.mock('../api/endpoints', async importOriginal => {
  const original = await importOriginal<typeof import('../api/endpoints')>()
  return {
    ...original,
    referenceApi: { ...original.referenceApi, routingUnits: vi.fn() },
    workflowApi: { ...original.workflowApi, createRequest: vi.fn() }
  }
})

vi.mock('react-router-dom', async importOriginal => {
  const original = await importOriginal<typeof import('react-router-dom')>()
  return { ...original, useNavigate: () => navigate }
})

afterEach(() => {
  cleanup()
  navigate.mockReset()
  vi.mocked(referenceApi.routingUnits).mockReset()
  vi.mocked(workflowApi.createRequest).mockReset()
})

describe('new workflow request (v5 contract)', () => {
  it('creates requests with requestType + routingUnitId only and navigates to preparation', async () => {
    vi.mocked(referenceApi.routingUnits).mockResolvedValue([
      { id: 'unit-1', nameAr: 'نيابة أ', nameEn: null, code: 'RU-01', isActive: true },
      { id: 'unit-2', nameAr: 'نيابة ب', nameEn: null, code: 'RU-02', isActive: true }
    ])
    vi.mocked(workflowApi.createRequest).mockResolvedValue({
      id: 'request-9', requestNumber: 'R9', requestType: 'SECONDMENT', routingUnitId: 'unit-2',
      routingUnitNameAr: 'نيابة ب', routingUnitCode: 'RU-02', status: 'DRAFT',
      currentIterationId: null, currentIterationNo: 1, currentStageCode: 'S1',
      currentExecutionId: null, currentWorkState: null, currentResponsibleUnitId: null,
      currentResponsibleUnitName: null, version: 1, createdByUserId: null,
      createdByUserDisplayName: null, createdAt: new Date().toISOString(),
      completedAt: null, cancelledAt: null
    })

    render(<MemoryRouter><NewRequestPage /></MemoryRouter>)

    const typeRadio = await screen.findByRole('radio', { name: /ندب/ })
    fireEvent.click(typeRadio)

    const unitSelect = await screen.findByRole('combobox')
    fireEvent.change(unitSelect, { target: { value: 'unit-2' } })

    fireEvent.click(screen.getByRole('button', { name: /إنشاء الطلب/ }))

    await waitFor(() => expect(workflowApi.createRequest).toHaveBeenCalledWith({
      requestType: 'SECONDMENT',
      routingUnitId: 'unit-2'
    }))
    expect(navigate).toHaveBeenCalledWith('/requests/request-9')
  })

  it('does not send legacy form-period fields even when present in older drafts', async () => {
    vi.mocked(referenceApi.routingUnits).mockResolvedValue([
      { id: 'unit-1', nameAr: 'نيابة أ', nameEn: null, code: 'RU-01', isActive: true }
    ])
    vi.mocked(workflowApi.createRequest).mockResolvedValue({
      id: 'request-10', requestNumber: 'R10', requestType: 'PROMOTION', routingUnitId: 'unit-1',
      routingUnitNameAr: 'نيابة أ', routingUnitCode: 'RU-01', status: 'DRAFT',
      currentIterationId: null, currentIterationNo: 1, currentStageCode: 'P1',
      currentExecutionId: null, currentWorkState: null, currentResponsibleUnitId: null,
      currentResponsibleUnitName: null, version: 1, createdByUserId: null,
      createdByUserDisplayName: null, createdAt: new Date().toISOString(),
      completedAt: null, cancelledAt: null
    })

    render(<MemoryRouter><NewRequestPage /></MemoryRouter>)
    const submit = await screen.findByRole('button', { name: /إنشاء الطلب/ })
    fireEvent.click(submit)

    await waitFor(() => expect(workflowApi.createRequest).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(workflowApi.createRequest).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['requestType', 'routingUnitId'])
  })
})

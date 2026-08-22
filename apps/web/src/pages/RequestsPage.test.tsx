import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowApi } from '../api/endpoints'
import type { WorkflowRequestSummary } from '../api/workflow-types'
import { RequestsPage } from './RequestsPage'

vi.mock('../api/endpoints', async importOriginal => {
  const original = await importOriginal<typeof import('../api/endpoints')>()
  return { ...original, workflowApi: { ...original.workflowApi, listRequests: vi.fn() } }
})

function summaryFixture(overrides: Partial<WorkflowRequestSummary>): WorkflowRequestSummary {
  return {
    id: overrides.id ?? 'req-1',
    requestNumber: 'REQ-100',
    requestType: 'PROMOTION',
    routingUnitId: 'ru-1',
    routingUnitNameAr: 'نيابة تجريبية',
    routingUnitCode: 'RU-1',
    status: 'ACTIVE',
    currentIterationId: null,
    currentIterationNo: 1,
    currentStageCode: 'P2',
    currentExecutionId: null,
    currentWorkState: 'MANAGER_INBOX',
    currentResponsibleUnitId: null,
    currentResponsibleUnitName: null,
    version: 1,
    createdByUserId: null,
    createdByUserDisplayName: 'منشئ تجريبي',
    createdAt: new Date().toISOString(),
    completedAt: null,
    cancelledAt: null,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.mocked(workflowApi.listRequests).mockReset()
})

describe('requests history (current DTO vocabulary)', () => {
  it('forwards the search query to the server-scoped request filter', async () => {
    vi.mocked(workflowApi.listRequests).mockResolvedValue([
      summaryFixture({ id: 'req-1', requestNumber: 'REQ-100' })
    ])

    render(<MemoryRouter initialEntries={['/requests?q=100']}><RequestsPage /></MemoryRouter>)

    await waitFor(() => expect(workflowApi.listRequests).toHaveBeenCalledWith(0, 50, expect.objectContaining({query:'100'})))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(2) // header + REQ-100 only
    expect(screen.queryByText('REQ-200')).toBeNull()
  })

  it('uses the v5 stage/status columns and never the obsolete RETURNED status', async () => {
    vi.mocked(workflowApi.listRequests).mockResolvedValue([
      summaryFixture({ id: 'req-1' })
    ])
    render(<MemoryRouter><RequestsPage /></MemoryRouter>)
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('P2')
    const statusSelect = screen.getByLabelText(/الحالة/)
    const options = within(statusSelect).getAllByRole('option').map(option => (option as HTMLOptionElement).value)
    expect(options).not.toContain('RETURNED')
    expect(options).toContain('REJECTED_PENDING_HR_DECISION')
  })
})

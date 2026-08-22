import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowApi } from '../api/endpoints'
import type { ManagerInboxResponse, StageExecutionSummary } from '../api/workflow-types'
import { ManagerInboxPage } from './ManagerInboxPage'

vi.mock('../api/endpoints', async importOriginal => {
  const original = await importOriginal<typeof import('../api/endpoints')>()
  return {
    ...original,
    workflowApi: {
      ...original.workflowApi,
      managerInbox: vi.fn(),
      takeStage: vi.fn(),
      restartRequest: vi.fn(),
      cancelRequest: vi.fn()
    }
  }
})

function stageFixture(overrides: Partial<StageExecutionSummary>): StageExecutionSummary {
  return {
    id: 'stage-1',
    iterationId: 'iter-1',
    iterationNo: 1,
    requestId: 'req-1',
    requestNumber: 'REQ-500',
    requestType: 'PROMOTION',
    routingUnitId: 'ru-1',
    routingUnitNameAr: 'نيابة تجريبية',
    stageCode: 'P2',
    executionNo: 2,
    responsibleUnitId: 'org-unit',
    responsibleUnitName: 'الوحدة التنظيمية',
    responsibleUnitKind: 'ORG',
    status: 'OPEN',
    workState: 'MANAGER_INBOX',
    openedAt: new Date().toISOString(),
    completedAt: null,
    activeAssigneeUserId: null,
    activeAssigneeDisplayName: null,
    assignedAt: null,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.mocked(workflowApi.managerInbox).mockReset()
  vi.mocked(workflowApi.takeStage).mockReset()
})

describe('manager inbox (v5 stage-execution model)', () => {
  it('loads open stages with the previous-worker suggestion shown as a hint only', async () => {
    vi.mocked(workflowApi.managerInbox).mockResolvedValue({
      stages: [stageFixture({
        suggestedAssigneeUserId: 'user-9',
        suggestedAssigneeDisplayName: 'موظف سابق تجريبي'
      })],
      rejectedRequests: []
    } satisfies ManagerInboxResponse)

    render(<MemoryRouter><ManagerInboxPage /></MemoryRouter>)

    const table = await screen.findByRole('table')
    expect(within(table).getByText('REQ-500')).toBeTruthy()
    expect(screen.getByText(/مقترح: موظف سابق تجريبي/)).toBeTruthy()

    // A suggestion must not create an assignment: no assign call happened by render time.
    expect(workflowApi.takeStage).not.toHaveBeenCalled()
  })

  it('lets the manager take the stage directly through the current command', async () => {
    vi.mocked(workflowApi.managerInbox).mockResolvedValue({
      stages: [stageFixture({})],
      rejectedRequests: []
    })
    vi.mocked(workflowApi.takeStage).mockResolvedValue(stageFixture({ workState: 'IN_PROGRESS' }))

    render(<MemoryRouter><ManagerInboxPage /></MemoryRouter>)
    const takeButton = await screen.findByRole('button', { name: /استلام مباشر/ })
    fireEvent.click(takeButton)

    await waitFor(() => expect(workflowApi.takeStage).toHaveBeenCalledWith('stage-1'))
    await waitFor(() => expect(workflowApi.managerInbox).toHaveBeenCalledTimes(2))
  })

  it('surfaces HR-only rejected requests with restart and cancel controls', async () => {
    const rejected = {
      id: 'req-77', requestNumber: 'REQ-700', requestType: 'SECONDMENT' as const,
      routingUnitId: 'ru-1', routingUnitNameAr: 'نيابة تجريبية', routingUnitCode: 'RU-1',
      status: 'REJECTED_PENDING_HR_DECISION' as const,
      currentIterationId: null, currentIterationNo: 3, currentStageCode: null,
      currentExecutionId: null, currentWorkState: null,
      currentResponsibleUnitId: null, currentResponsibleUnitName: null,
      version: 5, createdByUserId: null, createdByUserDisplayName: null,
      createdAt: new Date().toISOString(), completedAt: null, cancelledAt: null
    }
    vi.mocked(workflowApi.managerInbox).mockResolvedValue({ stages: [], rejectedRequests: [rejected] })
    vi.mocked(workflowApi.restartRequest).mockResolvedValue(rejected)

    render(<MemoryRouter><ManagerInboxPage /></MemoryRouter>)

    const restartButton = await screen.findByRole('button', { name: /إعادة الإنشاء من البداية/ })
    fireEvent.click(restartButton)
    await waitFor(() => expect(workflowApi.restartRequest).toHaveBeenCalledWith('req-77'))

    // Rejected requests expose no fabricated stage execution.
    expect(screen.queryByRole('table')).toBeNull()
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiJson, apiRequest } from '../api/client'
import type { WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { SecondmentWorkflowPanel } from './SecondmentWorkflowPanel'

vi.mock('../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, apiJson: vi.fn(), apiRequest: vi.fn() }
})
vi.mock('../auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const detail = {
  id: 'request-1', requestNumber: 'request-1', requestType: 'SECONDMENT', cycleYear: 2026,
  formMonth: 8, formYear: 2026, status: 'IN_PROGRESS', currentStage: 'S3', currentIterationNo: 1,
  routingUnit: { id: 'unit-1', nameAr: 'وحدة' }, approvingAuthority: null,
  createdBy: { id: 'ea-1', username: 'ea', displayName: 'شئون العاملين' }, candidateCount: 1,
  createdAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-16T10:00:00.000Z', version: 1,
  editable: false, actionable: true, candidates: [{
    id: 'candidate-1', snapshotYear: 2026, personnelNumber: '100', employeeName: 'عامل اختبار',
    subgroup: null, sourceRoutingUnit: null, routingUnitName: 'وحدة', currentJobTitle: 'وظيفة',
    performanceRating: 'ممتاز', qualificationSource1: null, qualificationSource2: null,
    qualificationDate: null, formSection: null, lastPromotionReport: null, displayOrder: 0, createdAt: '2026-08-16T10:00:00.000Z',
    warnings: { performanceRequiresAttention: false, performanceMissing: false }
  }]
} satisfies WorkflowRequestDetail

afterEach(() => { cleanup(); vi.mocked(apiJson).mockReset(); vi.mocked(apiRequest).mockReset(); vi.mocked(useAuth).mockReset() })

describe('Secondment stage panel', () => {
  it('selects only a server-supplied Organization option for the active candidate', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { activeRole: 'APPROVING_AUTHORITY' } } as ReturnType<typeof useAuth>)
    const option = { id: 'position-1', candidateId: 'candidate-1', iterationId: 'iteration-1', positionTitle: 'وظيفة مقترحة', organizationalDependency: 'تبعية', qualificationStatus: 'QUALIFIED', enteredById: 'org-1', enteredByName: 'التنظيم', displayOrder: 0, isSelected: false, selectedById: null, selectedAt: null, createdAt: '2026-08-16T10:00:00.000Z', version: 1 }
    vi.mocked(apiRequest).mockResolvedValue([option])
    vi.mocked(apiJson).mockResolvedValue([{ ...option, isSelected: true }])

    render(<MemoryRouter><SecondmentWorkflowPanel detail={detail} /></MemoryRouter>)
    const radio = await screen.findByRole('radio')
    fireEvent.click(radio)

    await waitFor(() => expect(apiJson).toHaveBeenCalledWith(
      '/api/workflow/requests/request-1/secondment/candidates/candidate-1/selection', 'PUT', { positionId: 'position-1' }
    ))
  })
})

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowApi } from '../api/endpoints'
import type { UserContext } from '../api/types'
import type { StageExecutionSummary } from '../api/workflow-types'
import { StageActionsPanel } from './StageActionsPanel'

vi.mock('../api/endpoints', async original => {
  const actual = await original<typeof import('../api/endpoints')>()
  return { ...actual, workflowApi: { ...actual.workflowApi, managerSubordinates: vi.fn(), internalCorrection: vi.fn(), approveAndAdvance: vi.fn(), submitToManager: vi.fn() } }
})
const manager: UserContext = { userId: 'manager', username: 'manager', staffIdentifier: null, displayName: 'المدير', jobTitle: null, accountType: 'OPERATIONAL', mustChangePassword: false, operationalContext: { membershipId: 'm', unitId: 'org', unitKind: 'ORG', routingUnitId: null, routingUnitName: null, isManager: true, managerAssignmentId: 'ma' } }
function stage(overrides: Partial<StageExecutionSummary> = {}): StageExecutionSummary { return { id: 'stage', iterationId: 'it', iterationNo: 1, requestId: 'request', requestNumber: 'REQ-1', requestType: 'PROMOTION', routingUnitId: null, routingUnitNameAr: null, stageCode: 'P3', executionNo: 1, responsibleUnitId: 'org', responsibleUnitName: 'التنظيم', responsibleUnitKind: 'ORG', status: 'OPEN', workState: 'MANAGER_REVIEW', openedAt: new Date().toISOString(), completedAt: null, activeAssigneeUserId: 'employee1', activeAssigneeDisplayName: 'الموظف الأول', assignedAt: new Date().toISOString(), ...overrides } }
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('standard manager correction and approval UX', () => {
  it('defaults to the previous employee, allows another employee, and offers manager self-work', async () => {
    vi.mocked(workflowApi.managerSubordinates).mockResolvedValue([{ userId: 'employee1', username: 'e1', displayName: 'الموظف الأول', jobTitle: null }, { userId: 'employee2', username: 'e2', displayName: 'الموظف الثاني', jobTitle: null }])
    vi.mocked(workflowApi.internalCorrection).mockResolvedValue(stage({ workState: 'CORRECTION_REQUIRED' }))
    render(<MemoryRouter><StageActionsPanel stage={stage()} user={manager} onChanged={() => {}} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'إعادة للموظف للتصحيح' }))
    const dialog = await screen.findByRole('dialog')
    const select = within(dialog).getByRole('combobox')
    await waitFor(() => expect(select).toHaveValue('employee1'))
    expect(within(select).getByRole('option', { name: 'إجراء التعديل بنفسي' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'employee2' } }); fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'سبب محفوظ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الإعادة للتصحيح' }))
    await waitFor(() => expect(workflowApi.internalCorrection).toHaveBeenCalledWith('stage', { reason: 'سبب محفوظ', assignedToUserId: 'employee2' }))

    fireEvent.click(screen.getByRole('button', { name: 'إعادة للموظف للتصحيح' }))
    const selfDialog = await screen.findByRole('dialog')
    fireEvent.change(within(selfDialog).getByRole('combobox'), { target: { value: '__SELF__' } })
    fireEvent.change(within(selfDialog).getByRole('textbox'), { target: { value: 'تعديل المدير' } })
    fireEvent.click(within(selfDialog).getByRole('button', { name: 'تأكيد الإعادة للتصحيح' }))
    await waitFor(() => expect(workflowApi.internalCorrection).toHaveBeenLastCalledWith('stage', { reason: 'تعديل المدير', managerHandlesPersonally: true }))
  })

  it('shows persistent correction reason to the assigned employee', () => {
    const employee = { ...manager, userId: 'employee1', operationalContext: { ...manager.operationalContext!, isManager: false, managerAssignmentId: null } }
    render(<MemoryRouter><StageActionsPanel stage={stage({ workState: 'CORRECTION_REQUIRED', correctionReason: 'استكمال المستند', correctionRequestedByDisplayName: 'مدير التنظيم' })} user={employee} onChanged={() => {}} /></MemoryRouter>)
    expect(screen.getByText('استكمال المستند')).toBeInTheDocument(); expect(screen.getByText(/مدير التنظيم/)).toBeInTheDocument()
  })

  it('keeps non-signing stages on normal approval without password UI', () => {
    render(<MemoryRouter><StageActionsPanel stage={stage({ stageCode: 'P3' })} user={manager} onChanged={() => {}} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /اعتماد والمتابعة/ })).toBeInTheDocument(); expect(screen.queryByText(/كلمة المرور/)).not.toBeInTheDocument()
  })
})

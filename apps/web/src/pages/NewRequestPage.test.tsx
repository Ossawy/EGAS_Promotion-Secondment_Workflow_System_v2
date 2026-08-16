import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiJson } from '../api/client'
import { NewRequestPage } from './NewRequestPage'

const navigate = vi.fn()

vi.mock('../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, apiJson: vi.fn() }
})

vi.mock('react-router-dom', async importOriginal => {
  const original = await importOriginal<typeof import('react-router-dom')>()
  return { ...original, useNavigate: () => navigate }
})

afterEach(() => {
  cleanup()
  navigate.mockReset()
  vi.mocked(apiJson).mockReset()
})

describe('new workflow request', () => {
  it('creates the selected request type through the real Phase 3A contract', async () => {
    vi.mocked(apiJson).mockResolvedValue({ id: 'request-1' })
    render(<MemoryRouter><NewRequestPage /></MemoryRouter>)

    fireEvent.click(screen.getByRole('radio', { name: /ندب/ }))
    fireEvent.click(screen.getByRole('button', { name: /إنشاء المسودة والمتابعة/ }))

    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/workflow/requests', 'POST', expect.objectContaining({
      requestType: 'SECONDMENT', formMonth: expect.any(Number), formYear: expect.any(Number), cycleYear: expect.any(Number)
    })))
    expect(navigate).toHaveBeenCalledWith('/requests/request-1', { replace: true })
  })
})

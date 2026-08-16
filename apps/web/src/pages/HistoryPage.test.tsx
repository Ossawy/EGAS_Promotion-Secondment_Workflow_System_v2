import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../api/client'
import { HistoryPage } from './HistoryPage'

vi.mock('../api/client', async importOriginal => {
  const original = await importOriginal<typeof import('../api/client')>()
  return { ...original, apiRequest: vi.fn() }
})

afterEach(() => { cleanup(); vi.mocked(apiRequest).mockReset() })

describe('role-scoped history page', () => {
  it('forwards the bounded top-bar query and renders a truthful scoped empty state', async () => {
    vi.mocked(apiRequest).mockImplementation(path => Promise.resolve(String(path).includes('/reference/') ? [] : []))
    render(<MemoryRouter initialEntries={['/history?q=REQ-100']}><HistoryPage /></MemoryRouter>)
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.stringMatching(
      /^\/api\/workflow\/history\?skip=0&top=50&q=REQ-100$/
    )))
    expect(await screen.findByText('لا توجد نتائج ضمن نطاقك')).toBeInTheDocument()
    expect(screen.getByDisplayValue('REQ-100')).toBeInTheDocument()
  })
})

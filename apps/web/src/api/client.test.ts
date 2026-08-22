import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiJson, ApiError, csrfToken } from './client'

afterEach(() => {
  document.cookie = 'EGAS_SESSION_CSRF=; Max-Age=0; Path=/'
})

describe('API client', () => {
  it('reads the CSRF token without persisting authentication data', () => {
    document.cookie = 'EGAS_SESSION_CSRF=csrf-value; Path=/'
    expect(csrfToken()).toBe('csrf-value')
  })

  it('sends same-origin credentials and CSRF on mutations', async () => {
    document.cookie = 'EGAS_SESSION_CSRF=csrf-value; Path=/'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))

    await apiJson('/api/test', 'POST', { value: 1 })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.credentials).toBe('same-origin')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-value')
  })

  it('maps safe structured API failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'UNIT_MANAGER_REQUIRED', message: 'Active role required' }
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))

    await expect(apiJson('/api/test', 'POST', {})).rejects.toEqual(
      expect.objectContaining({
        name: 'ApiError',
        status: 403,
        code: 'UNIT_MANAGER_REQUIRED',
        message: 'Active role required'
      } satisfies Partial<ApiError>)
    )
  })
})

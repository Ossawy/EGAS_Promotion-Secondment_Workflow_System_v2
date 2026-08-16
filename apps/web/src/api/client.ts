import type { ApiErrorPayload } from './types'

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function cookieValue(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`
  for (const part of document.cookie.split(';')) {
    const candidate = part.trim()
    if (candidate.startsWith(prefix)) return decodeURIComponent(candidate.slice(prefix.length))
  }
  return null
}

export function csrfToken(): string | null {
  const configured = import.meta.env.VITE_EGAS_CSRF_COOKIE_NAME as string | undefined
  if (configured) return cookieValue(configured)

  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = decodeURIComponent(part.slice(0, separator).trim())
    if (name.endsWith('_CSRF')) return decodeURIComponent(part.slice(separator + 1))
  }
  return null
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (mutationMethods.has(method)) {
    const token = csrfToken()
    if (token) headers.set('X-CSRF-Token', token)
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'same-origin'
  })

  if (!response.ok) {
    let payload: ApiErrorPayload = {}
    try {
      payload = await response.json() as ApiErrorPayload
    } catch {
      // The API normally returns JSON; keep a safe generic fallback for proxy failures.
    }
    throw new ApiError(
      response.status,
      payload.error?.code ?? 'REQUEST_FAILED',
      payload.error?.message ?? 'تعذر إتمام الطلب. يرجى المحاولة مرة أخرى.'
    )
  }

  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export function apiJson<T>(path: string, method: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method, body: JSON.stringify(body) })
}

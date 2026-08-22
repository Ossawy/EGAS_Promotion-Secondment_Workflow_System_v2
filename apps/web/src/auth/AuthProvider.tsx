import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from 'react'
import { ApiError } from '../api/client'
import { authApi } from '../api/endpoints'
import type { UserContext } from '../api/types'

type AuthState = {
  user: UserContext | null
  loading: boolean
  error: string | null
  login(username: string, password: string): Promise<UserContext>
  changePassword(currentPassword: string, newPassword: string): Promise<UserContext>
  logout(): Promise<void>
  clearError(): void
}

const AuthContext = createContext<AuthState | null>(null)

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : 'تعذر الاتصال بالخدمة. تحقق من الشبكة وحاول مجدداً.'
}

export function AuthProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [user, setUser] = useState<UserContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    authApi.me()
      .then(context => { if (active) setUser(context) })
      .catch(requestError => {
        if (active && (!(requestError instanceof ApiError) || requestError.status !== 401)) {
          setError(message(requestError))
        }
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const update = useCallback(async (operation: () => Promise<UserContext>) => {
    setError(null)
    try {
      const context = await operation()
      setUser(context)
      return context
    } catch (requestError) {
      setError(message(requestError))
      throw requestError
    }
  }, [])

  const login = useCallback((username: string, password: string) => update(
    () => authApi.login(username, password)
  ), [update])

  const changePassword = useCallback((currentPassword: string, newPassword: string) => update(
    () => authApi.changePassword(currentPassword, newPassword)
  ), [update])

  const logout = useCallback(async () => {
    setError(null)
    try {
      await authApi.logout()
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    error,
    login,
    changePassword,
    logout,
    clearError: () => setError(null)
  }), [user, loading, error, login, changePassword, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider')
  return value
}

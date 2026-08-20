import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  Building2,
  ChevronLeft,
  Database,
  FileClock,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  UserCog,
  UserRound,
  Users,
  X,
  type LucideIcon
} from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { apiJson, apiRequest } from '../api/client'
import type { NotificationItem } from '../api/workflow-types'
import type { Role } from '../api/types'
import { BrandMark } from '../components/BrandMark'
import { useAuth } from '../auth/AuthProvider'

type NavigationItem = { to: string, label: string, icon: LucideIcon }

const roleLabels: Record<Role, string> = {
  ADMIN: 'إدارة النظام',
  EMPLOYEE_AFFAIRS: 'شئون العاملين',
  ORGANIZATION: 'إدارة التنظيم',
  APPROVING_AUTHORITY: 'سلطة الاعتماد'
}

const commonTail: NavigationItem[] = [
  { to: '/notifications', label: 'الإشعارات', icon: Bell }
]

const navigation: Record<Role, NavigationItem[]> = {
  EMPLOYEE_AFFAIRS: [
    { to: '/', label: 'لوحة المتابعة', icon: LayoutDashboard },
    { to: '/requests', label: 'طلباتي', icon: FileClock },
    { to: '/requests/new', label: 'طلب جديد', icon: Inbox },
    { to: '/history', label: 'البحث والسجل', icon: History },
    ...commonTail
  ],
  ORGANIZATION: [
    { to: '/', label: 'الرئيسية', icon: LayoutDashboard },
    { to: '/requests', label: 'الطلبات غير المسندة', icon: Inbox },
    { to: '/history', label: 'البحث والسجل', icon: History },
    ...commonTail
  ],
  APPROVING_AUTHORITY: [
    { to: '/', label: 'الرئيسية', icon: LayoutDashboard },
    { to: '/requests', label: 'الطلبات', icon: ShieldCheck },
    { to: '/history', label: 'سجل القرارات', icon: History },
    ...commonTail
  ],
  ADMIN: [
    { to: '/', label: 'لوحة الإدارة', icon: LayoutDashboard },
    { to: '/admin/users', label: 'المستخدمون', icon: Users },
    { to: '/admin/authorities', label: 'تعيينات السلطة', icon: UserCog },
    { to: '/admin/dataset', label: 'البيانات السنوية', icon: Database },
    { to: '/admin/audit', label: 'التدقيق', icon: History },
    ...commonTail
  ]
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 1) return 'الآن'
  if (minutes < 60) return `منذ ${minutes} دقيقة`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `منذ ${hours} ساعة`
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value))
}

export function AppShell(): React.JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [globalSearch, setGlobalSearch] = useState('')
  const user = auth.user
  const role = useMemo(() => {
    if (user?.accountType === 'ADMIN') return 'ADMIN'
    if (user?.operationalContext?.unitKind === 'HR') return 'EMPLOYEE_AFFAIRS'
    if (user?.operationalContext?.unitKind === 'ORG') return 'ORGANIZATION'
    if (user?.operationalContext?.isManager && user?.operationalContext?.unitKind === 'AUTH') return 'APPROVING_AUTHORITY'
    return null
  }, [user])

  const items = useMemo(() => role ? navigation[role] : [], [role])

  useEffect(() => {
    let active = true
    Promise.all([apiRequest<NotificationItem[]>('/api/notifications?top=8'), apiRequest<{ count: number }>('/api/notifications/unread-count')])
      .then(([items, unread]) => { if (active) { setNotifications(items); setUnreadCount(unread.count) } })
      .catch(() => { if (active) { setNotifications([]); setUnreadCount(0) } })
    return () => { active = false }
  }, [role])

  useEffect(() => {
    function closeOverlays(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setNotificationsOpen(false)
      }
    }
    document.addEventListener('keydown', closeOverlays)
    return () => document.removeEventListener('keydown', closeOverlays)
  }, [])

  async function markRead(item: NotificationItem): Promise<void> {
    if (!item.isRead) {
      try {
        const updated = await apiJson<NotificationItem>(`/api/notifications/${item.id}/read`, 'POST', {})
        setNotifications(current => current.map(entry => entry.id === updated.id ? updated : entry))
        setUnreadCount(value => Math.max(0, value - 1))
      } catch {}
    }
    if (item.requestId) navigate(`/requests/${item.requestId}`)
    setNotificationsOpen(false)
  }

  async function logout(): Promise<void> {
    await auth.logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">تخطي إلى المحتوى الرئيسي</a>
      {menuOpen && <button type="button" className="shell-scrim" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)} />}
      <aside id="main-navigation" className={`sidebar${menuOpen ? ' sidebar--open' : ''}`} aria-label="الشريط الجانبي">
        <div className="sidebar__brand">
          <BrandMark />
          <button type="button" className="icon-button sidebar__close" onClick={() => setMenuOpen(false)} aria-label="إغلاق القائمة"><X /></button>
        </div>
        <nav className="sidebar__nav" aria-label="التنقل الرئيسي">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <Link to="/" className="sidebar__user">
            <span className="avatar"><UserRound size={20} /></span>
            <span><strong>{auth.user?.displayName}</strong><small>{role ? roleLabels[role] : ''}</small></span>
            <ChevronLeft size={18} aria-hidden="true" />
          </Link>
          <button className="sidebar__logout" type="button" onClick={() => void logout()}><LogOut size={20} /> تسجيل الخروج</button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button type="button" className="icon-button topbar__menu" onClick={() => setMenuOpen(true)} aria-label="فتح القائمة" aria-controls="main-navigation" aria-expanded={menuOpen}><Menu /></button>
          <form className="topbar__search" onSubmit={event => { event.preventDefault(); const value = globalSearch.trim(); navigate(value ? `/history?q=${encodeURIComponent(value)}` : '/history') }}>
            <Search size={20} aria-hidden="true" />
            <input type="search" aria-label="بحث شامل" value={globalSearch} onChange={event => setGlobalSearch(event.target.value)} maxLength={120} placeholder="رقم طلب أو رقم عامل..." />
          </form>
          <div className="topbar__actions">
            <button type="button" className="icon-button notification-button" aria-label={`الإشعارات، ${unreadCount} غير مقروء`} aria-controls="notification-drawer" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(value => !value)}>
              <Bell size={22} />{unreadCount > 0 && <span aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
            <span className="sr-only" aria-live="polite">{unreadCount} إشعار غير مقروء</span>
          </div>
        </header>
        {notificationsOpen && (
          <aside id="notification-drawer" className="notification-drawer" aria-label="أحدث الإشعارات">
            <div className="notification-drawer__header">
              <div><Bell size={20} /><strong>الإشعارات</strong></div>
              <button type="button" className="icon-button" onClick={() => setNotificationsOpen(false)} aria-label="إغلاق"><X size={20} /></button>
            </div>
            {notifications.length === 0 ? (
              <p className="notification-drawer__empty">لا توجد إشعارات حالياً.</p>
            ) : (
              <div className="notification-list">
                {notifications.map(item => (
                  <button type="button" key={item.id} className={`notification-item${item.isRead ? '' : ' notification-item--unread'}`} onClick={() => void markRead(item)}>
                    <span className="notification-item__dot" aria-hidden="true" />
                    <span><strong>{item.titleAr}</strong>{item.bodyAr && <small>{item.bodyAr}</small>}<time>{relativeTime(item.createdAt)}</time></span>
                  </button>
                ))}
              </div>
            )}
            <Link className="notification-drawer__all" to="/notifications" onClick={() => setNotificationsOpen(false)}>عرض كل الإشعارات <ChevronLeft size={17} /></Link>
          </aside>
        )}
        <main id="main-content" className="workspace__content" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  )
}

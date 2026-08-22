import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell,
  Building2,
  ChevronLeft,
  FileClock,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  PenLine,
  Search,
  UserRound,
  Users,
  X,
  type LucideIcon
} from 'lucide-react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { workflowApi } from '../api/endpoints'
import { UNIT_KIND_LABELS } from '../api/types'
import type { NotificationSummary } from '../api/workflow-types'
import { STAGE_LABELS } from '../api/workflow-types'
import { BrandMark } from '../components/BrandMark'
import { useAuth } from '../auth/AuthProvider'
import { arabicErrorMessage } from '../api/messages'

type NavigationItem = { to: string, label: string, icon: LucideIcon }

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  STAGE_INBOX_ARRIVED: 'وصلت مرحلة جديدة إلى صندوق المدير',
  STAGE_ASSIGNED: 'تم إسناد عمل جديد إليك',
  STAGE_SUBMITTED_TO_MANAGER: 'رفع الموظف العمل للمراجعة',
  CORRECTION_REQUIRED: 'مطلوب تصحيح منك على مرحلة مسندة',
  STAGE_RETURNED: 'أُرجعت إليك مرحلة من مرحلة لاحقة',
  WORKFLOW_REJECTED: 'تم رفض طلب — بانتظار قرار الموارد البشرية'
}

function notificationLabel(item: NotificationSummary): string {
  return NOTIFICATION_TYPE_LABELS[item.notificationType] ?? 'إشعار نظامي جديد'
}

function identityLabel(isAdmin: boolean, unitKind?: string | null, isManager?: boolean): string {
  if (isAdmin) return 'إدارة النظام'
  if (!unitKind) return ''
  const base = UNIT_KIND_LABELS[unitKind as keyof typeof UNIT_KIND_LABELS] ?? unitKind
  return isManager ? `${base} — مدير الوحدة` : base
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 1) return 'الآن'
  if (minutes < 60) return `منذ ${minutes} دقيقة`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `منذ ${hours} ساعة`
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(value))
}

export function useNotifications(pollTop = 8, enabled = true) {
  const [notifications, setNotifications] = useState<NotificationSummary[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const [recent, unread] = await Promise.all([
        workflowApi.notifications(pollTop),
        workflowApi.notifications(100, true)
      ])
      setNotifications(recent)
      setUnreadCount(unread.length)
      setError(null)
    } catch (requestError) {
      setError(arabicErrorMessage(requestError))
    }
  }, [enabled, pollTop])

  useEffect(() => {
    void reload()
  }, [reload])

  const markRead = useCallback(async (item: NotificationSummary): Promise<void> => {
    if (!item.isRead) {
      try {
        await workflowApi.markNotificationRead(item.id)
        setNotifications(current => current.map(entry => entry.id === item.id ? { ...entry, isRead: true } : entry))
        setUnreadCount(value => Math.max(0, value - 1))
      } catch {}
    }
  }, [])

  return { notifications, unreadCount, error, reload, markRead, setNotifications }
}

export function AppShell(): React.JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const user = auth.user
  const isAdmin = user?.accountType === 'ADMIN'
  const operationalContext = user?.operationalContext ?? null

  const items = useMemo<NavigationItem[]>(() => {
    if (isAdmin) {
      return [
        { to: '/', label: 'الرئيسية', icon: LayoutDashboard },
        { to: '/admin/accounts', label: 'الحسابات', icon: Users },
        { to: '/admin/units', label: 'الوحدات التشغيلية', icon: Building2 },
        { to: '/admin/audit', label: 'سجل التدقيق', icon: History }
      ]
    }
    const list: NavigationItem[] = [{ to: '/', label: 'الرئيسية', icon: LayoutDashboard }]
    if (operationalContext?.isManager) {
      list.push({ to: '/inbox', label: 'صندوق المدير', icon: Inbox })
    }
    if (operationalContext?.unitKind === 'HR') {
      list.push({ to: '/requests/new', label: 'إنشاء طلب', icon: PenLine })
    }
    list.push(
      { to: '/my-work', label: 'عملي', icon: FileClock },
      { to: '/requests', label: 'الطلبات والسجل', icon: History },
      { to: '/notifications', label: 'الإشعارات', icon: Bell },
      { to: '/signature', label: 'إعدادات التوقيع', icon: PenLine }
    )
    return list
  }, [isAdmin, operationalContext])

  // Notifications only apply to operational accounts.
  const needsNotifications = !isAdmin
  const { notifications, unreadCount, reload, markRead } = useNotifications(8, needsNotifications)

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

  async function openNotification(item: NotificationSummary): Promise<void> {
    await markRead(item)
    setNotificationsOpen(false)
    if (item.requestId) navigate(`/requests/${item.requestId}`)
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
            <span><strong>{user?.displayName}</strong><small>{identityLabel(isAdmin, operationalContext?.unitKind, operationalContext?.isManager)}</small></span>
            <ChevronLeft size={18} aria-hidden="true" />
          </Link>
          <button className="sidebar__logout" type="button" onClick={() => void logout()}><LogOut size={20} /> تسجيل الخروج</button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button type="button" className="icon-button topbar__menu" onClick={() => setMenuOpen(true)} aria-label="فتح القائمة" aria-controls="main-navigation" aria-expanded={menuOpen}><Menu /></button>
          <form className="topbar__search" onSubmit={event => { event.preventDefault(); const value = globalSearch.trim(); navigate(isAdmin ? (value ? `/admin/audit?actor=${encodeURIComponent(value)}` : '/admin/audit') : (value ? `/requests?q=${encodeURIComponent(value)}` : '/requests')) }}>
            <Search size={20} aria-hidden="true" />
            <input type="search" aria-label={isAdmin ? 'بحث باسم منفذ في سجل التدقيق' : 'بحث في الطلبات'} value={globalSearch} onChange={event => setGlobalSearch(event.target.value)} maxLength={120} placeholder={isAdmin ? 'اسم منفذ الإجراء...' : 'رقم الطلب أو اسم الموظف...'} />
          </form>
          {!isAdmin && (
            <div className="topbar__actions">
              <button type="button" className="icon-button notification-button" aria-label={`الإشعارات، ${unreadCount} غير مقروء`} aria-controls="notification-drawer" aria-expanded={notificationsOpen} onClick={() => { if (!notificationsOpen) void reload(); setNotificationsOpen(value => !value) }}>
                <Bell size={22} />{unreadCount > 0 && <span aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
              </button>
              <span className="sr-only" aria-live="polite">{unreadCount} إشعار غير مقروء</span>
            </div>
          )}
        </header>
        {needsNotifications && notificationsOpen && (
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
                  <button type="button" key={item.id} className={`notification-item${item.isRead ? '' : ' notification-item--unread'}`} onClick={() => void openNotification(item)}>
                    <span className="notification-item__dot" aria-hidden="true" />
                    <span>
                      <strong>{notificationLabel(item)}</strong>
                      {item.requestNumber && <small>طلب {item.requestNumber}{item.stageCode ? ` • ${STAGE_LABELS[item.stageCode]}` : ''}</small>}
                      <time>{relativeTime(item.createdAt)}</time>
                    </span>
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

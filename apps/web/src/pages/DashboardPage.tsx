import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileCheck2,
  Inbox,
  Plus,
  RotateCcw,
  ShieldCheck,
  Users
} from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { apiJson, apiRequest } from '../api/client'
import type { ActiveSnapshot, QueueItem, WorkflowRequestSummary } from '../api/workflow-types'
import type { Role } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { AdminDashboardPage } from './admin/AdminDashboardPage'

type DashboardData = {
  requests: WorkflowRequestSummary[]
  queue: QueueItem[]
  snapshot: ActiveSnapshot | null
  snapshotUnavailable: boolean
}

const initialData: DashboardData = { requests: [], queue: [], snapshot: null, snapshotUnavailable: false }

const workflowLabel = (type: string) => type === 'PROMOTION' ? 'ترقية' : 'ندب'
const stageLabel = (stage: string) => ({
  P1: 'شئون العاملين', P2: 'إدارة التنظيم', P3: 'مراجعة شئون العاملين', P4: 'سلطة الاعتماد', P5: 'الاعتماد النهائي',
  S1: 'شئون العاملين', S2: 'إدارة التنظيم', S3: 'سلطة الاعتماد', S4: 'تأكيد إدارة التنظيم', S5: 'الاعتماد النهائي'
}[stage] ?? stage)

function MetricCard({ label, value, icon, tone = 'default', caption }: { label: string, value: number, icon: ReactNode, tone?: string, caption?: string }): React.JSX.Element {
  return <article className={`metric-card metric-card--${tone}`}>
    <div><p>{label}</p><strong>{value}</strong>{caption && <small>{caption}</small>}</div>
    <span aria-hidden="true">{icon}</span>
  </article>
}

function RequestsTable({ items, queue = false }: { items: Array<WorkflowRequestSummary | QueueItem>, queue?: boolean }): React.JSX.Element {
  const navigate = useNavigate()
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  async function claim(item: QueueItem): Promise<void> {
    setClaiming(item.taskId); setClaimError(null)
    try {
      await apiJson(`/api/workflow/tasks/${item.taskId}/claim`, 'POST', {})
      navigate(`/requests/${item.requestId}`)
    } catch { setClaimError('تعذر استلام الطلب؛ ربما استلمه مستخدم آخر. حدّث القائمة وحاول مجدداً.') }
    finally { setClaiming(null) }
  }
  if (items.length === 0) return <EmptyState icon={Inbox} title="لا توجد طلبات" body="ستظهر هنا الطلبات المتاحة ضمن نطاق الدور النشط عند ورودها." />
  return <>{claimError && <p className="error table-error" role="alert">{claimError}</p>}<div className="table-scroll"><table className="data-table">
    <thead><tr><th>رقم الطلب</th><th>النوع</th><th>الوحدة التنظيمية</th><th>عدد الموظفين</th><th>المرحلة / الحالة</th><th>الإجراء</th></tr></thead>
    <tbody>{items.slice(0, 8).map(item => {
      const isQueue = 'taskId' in item
      const id = isQueue ? item.requestId : item.id
      const unit = isQueue ? item.routingUnitName : item.routingUnit?.nameAr
      const status = isQueue ? item.taskStatus : item.status
      const stage = isQueue ? item.stageCode : item.currentStage
      return <tr key={id}>
        <td className="mono">{item.requestNumber}</td>
        <td>{workflowLabel(item.requestType)}</td>
        <td>{unit ?? 'لم يتحدد بعد'}</td>
        <td>{item.candidateCount}</td>
        <td><StatusBadge status={status} label={queue ? stageLabel(stage) : undefined} /></td>
        <td>{queue && isQueue && item.claimable ? <button className="table-action" disabled={claiming === item.taskId} onClick={() => void claim(item)}>{claiming === item.taskId ? 'جارٍ الاستلام...' : 'استلام الطلب'}</button> : <Link className="table-action" to={`/requests/${id}`}>عرض الطلب</Link>}</td>
      </tr>
    })}</tbody>
  </table></div></>
}

function EmployeeAffairsDashboard({ data }: { data: DashboardData }): React.JSX.Element {
  const active = data.requests.filter(item => item.status === 'IN_PROGRESS').length
  const returned = data.requests.filter(item => item.status === 'RETURNED').length
  const completed = data.requests.filter(item => item.status === 'COMPLETED').length
  const drafts = data.requests.filter(item => item.status === 'DRAFT').length
  return <>
    {data.snapshotUnavailable && <div className="state-banner state-banner--warning"><AlertTriangle size={21} /><div><strong>لا توجد لقطة سنوية نشطة</strong><span>يمكن استعراض الطلبات السابقة، لكن إضافة موظفين جدد ستظل متوقفة حتى تفعيل البيانات المعتمدة.</span></div></div>}
    <section className="metric-grid">
      <MetricCard label="مسوداتي" value={drafts} icon={<ClipboardList />} />
      <MetricCard label="طلبات قيد الإجراء" value={active} icon={<Clock3 />} tone="warning" />
      <MetricCard label="طلبات مرتجعة" value={returned} icon={<RotateCcw />} tone="danger" />
      <MetricCard label="طلبات مكتملة" value={completed} icon={<CheckCircle2 />} tone="success" />
    </section>
    <div className="dashboard-actions"><Link className="button button--primary" to="/requests/new"><Plus size={19} /> طلب جديد</Link></div>
    <section className="panel"><div className="panel__header"><div><h2>أحدث الطلبات</h2><p>آخر الطلبات الظاهرة ضمن نطاق حسابك</p></div><Link to="/requests">عرض الكل</Link></div><RequestsTable items={data.requests} /></section>
  </>
}

function OrganizationDashboard({ data }: { data: DashboardData }): React.JSX.Element {
  const unassigned = data.queue.filter(item => item.claimable).length
  const mine = data.queue.filter(item => item.claimedByMe).length
  const others = data.queue.filter(item => item.taskStatus === 'CLAIMED' && !item.claimedByMe).length
  return <>
    <section className="metric-grid metric-grid--three">
      <MetricCard label="طلبات غير مسندة" value={unassigned} icon={<Inbox />} />
      <MetricCard label="طلباتي" value={mine} icon={<FileCheck2 />} tone="success" />
      <MetricCard label="استلمها زملاء" value={others} icon={<Users />} tone="info" />
    </section>
    <section className="panel"><div className="panel__header"><div><h2>الطلبات غير المسندة وطلبات التنظيم</h2><p>الاستلام يتم ذرياً ويظهر اسم المستلم لباقي فريق التنظيم</p></div><Link to="/requests">عرض الكل</Link></div><RequestsTable items={data.queue} queue /></section>
  </>
}

function AuthorityDashboard({ data }: { data: DashboardData }): React.JSX.Element {
  const promotion = data.queue.filter(item => item.requestType === 'PROMOTION').length
  const secondment = data.queue.filter(item => item.requestType === 'SECONDMENT').length
  return <>
    <section className="metric-grid metric-grid--three">
      <MetricCard label="طلبات بانتظار الإجراء" value={data.queue.length} icon={<Clock3 />} tone="info" />
      <MetricCard label="طلبات ترقية" value={promotion} icon={<ShieldCheck />} tone="success" />
      <MetricCard label="طلبات ندب" value={secondment} icon={<FileCheck2 />} />
    </section>
    <section className="panel"><div className="panel__header"><div><h2>الطلبات بانتظار الإجراء</h2><p>تظهر فقط المهام المسندة إلى حسابك ضمن الدور النشط</p></div><Link to="/requests">عرض الكل</Link></div><RequestsTable items={data.queue} queue /></section>
  </>
}

function title(role: Role | null | undefined): [string, string] {
  if (role === 'EMPLOYEE_AFFAIRS') return ['لوحة متابعة شئون العاملين', 'متابعة طلبات الترقية والندب والطلبات المرتجعة']
  if (role === 'ORGANIZATION') return ['لوحة تحكم إدارة التنظيم', 'الطلبات غير المسندة والمهام المستلمة']
  if (role === 'APPROVING_AUTHORITY') return ['لوحة تحكم سلطة الاعتماد', 'الطلبات المحالة لاتخاذ القرار']
  return ['لوحة إدارة النظام', 'الإدارة التشغيلية والأمنية للنظام']
}

export function DashboardPage(): React.JSX.Element {
  const auth = useAuth()
  const role = auth.user?.activeRole
  const [data, setData] = useState<DashboardData>(initialData)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [heading, subtitle] = title(role)

  useEffect(() => {
    let active = true
    setLoading(true); setError(null); setData(initialData)
    async function load(): Promise<void> {
      if (role === 'EMPLOYEE_AFFAIRS') {
        const [requests, snapshot] = await Promise.allSettled([
          apiRequest<WorkflowRequestSummary[]>('/api/workflow/requests?top=100'),
          apiRequest<ActiveSnapshot>('/api/employee-data/active-snapshot')
        ])
        if (requests.status === 'rejected') throw requests.reason
        if (active) setData({ requests: requests.value, queue: [], snapshot: snapshot.status === 'fulfilled' ? snapshot.value : null, snapshotUnavailable: snapshot.status === 'rejected' })
      } else if (role === 'ORGANIZATION') {
        const queue = await apiRequest<QueueItem[]>('/api/workflow/organization/queue?top=100')
        if (active) setData({ ...initialData, queue })
      } else if (role === 'APPROVING_AUTHORITY') {
        const queue = await apiRequest<QueueItem[]>('/api/workflow/authority/queue?top=100')
        if (active) setData({ ...initialData, queue })
      }
    }
    load().catch(() => { if (active) setError('تعذر تحميل بيانات لوحة المتابعة. يرجى تحديث الصفحة والمحاولة مجدداً.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [role])

  if (role === 'ADMIN') return <AdminDashboardPage />

  return <div className="page-stack">
    <header className="page-heading"><div><p>إيجاس / بوابة الموارد البشرية</p><h1>{heading}</h1><span>{subtitle}</span></div></header>
    {loading ? <div className="panel loading-panel" role="status"><span className="spinner" /> جارٍ تحميل البيانات...</div> :
      error ? <div className="state-banner state-banner--danger"><AlertTriangle /><div><strong>تعذر تحميل البيانات</strong><span>{error}</span></div></div> :
      role === 'EMPLOYEE_AFFAIRS' ? <EmployeeAffairsDashboard data={data} /> :
      role === 'ORGANIZATION' ? <OrganizationDashboard data={data} /> :
      role === 'APPROVING_AUTHORITY' ? <AuthorityDashboard data={data} /> : null}
  </div>
}

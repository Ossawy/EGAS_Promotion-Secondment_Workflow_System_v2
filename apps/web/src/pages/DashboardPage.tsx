import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, CheckCircle2, CircleAlert, Clock3, Inbox, ListChecks, LockKeyhole, Plus, RotateCcw, ShieldCheck, Users } from 'lucide-react'
import { adminApi, workflowApi } from '../api/endpoints'
import type { AdminDashboardSummary } from '../api/admin-types'
import { UNIT_KIND_LABELS, type UnitKind, type UserContext } from '../api/types'
import { REQUEST_STATUS_LABELS, STAGE_LABELS, type ManagerInboxResponse, type StageExecutionSummary, type WorkflowRequestSummary } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { adminAuditEventLabel } from '../api/admin-audit-labels'
import { arabicErrorMessage } from '../api/messages'

type IconType = React.ComponentType<{ size?: number | string }>

function Metric({ label, value, details, icon: Icon, tone = '' }: { label: string, value: number | string, details?: string, icon: IconType, tone?: string }): React.JSX.Element {
  return <article className={`metric-card${tone ? ` metric-card--${tone}` : ''}`}><div><p>{label}</p><strong>{value}</strong>{details && <small>{details}</small>}</div><span><Icon size={24} /></span></article>
}

function DashboardHeading({ eyebrow, title, subtitle }: { eyebrow: string, title: string, subtitle: string }): React.JSX.Element {
  return <header className="page-heading dashboard-heading"><div><p>{eyebrow}</p><h1>{title}</h1><span>{subtitle}</span></div></header>
}

function AdminDashboard(): React.JSX.Element {
  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null)
  const [error,setError]=useState<string|null>(null)
  useEffect(() => { adminApi.dashboard().then(value=>{setSummary(value);setError(null)}).catch(requestError => setError(arabicErrorMessage(requestError))) }, [])
  if(!summary)return <><DashboardHeading eyebrow="إيجاس / إدارة النظام" title="لوحة الإدارة" subtitle="مؤشرات تشغيلية وإدارية فقط؛ لا تعرض هذه اللوحة بيانات العاملين." />{error?<div className="empty-state"><strong className="error">{error}</strong></div>:<div className="loading-panel"><span className="spinner" /> جارٍ تحميل مؤشرات الإدارة...</div>}</>
  const units = summary?.operationalUnits
  return <>
    <DashboardHeading eyebrow="إيجاس / إدارة النظام" title="لوحة الإدارة" subtitle="مؤشرات تشغيلية وإدارية فقط؛ لا تعرض هذه اللوحة بيانات العاملين." />
    <div className="metric-grid">
      <Metric label="إجمالي الحسابات" value={summary?.accounts.total ?? '—'} details={`${summary?.accounts.active ?? 0} حساب نشط`} icon={Users} />
      <Metric label="معطل أو مقفل" value={(summary?.accounts.inactive ?? 0) + (summary?.accounts.locked ?? 0)} details={`${summary?.accounts.inactive ?? 0} معطل • ${summary?.accounts.locked ?? 0} مقفل`} icon={LockKeyhole} tone="danger" />
      <Metric label="الوحدات التشغيلية" value={units?.total ?? '—'} details="الوحدات النشطة المهيأة" icon={Building2} tone="info" />
      <Metric label="أحداث التدقيق الأخيرة" value={summary?.recentActivity.length ?? '—'} details="أحدث الأحداث المسجلة" icon={ShieldCheck} tone="success" />
    </div>
    <div className="dashboard-lower-grid">
      <section className="panel dashboard-audit-panel">
        <div className="panel__header"><div><h2>النشاط الإداري الأخير</h2><p>أحدث أحداث الإدارة والأمن المسجلة.</p></div><Link to="/admin/audit">عرض سجل التدقيق</Link></div>
        {summary?.recentActivity.length ? <ul className="dashboard-audit-list">{summary.recentActivity.map(item => <li key={item.id}><span><ShieldCheck size={18} /></span><div><strong>{adminAuditEventLabel(item.eventType)}</strong><small>{item.actorDisplayName ?? 'النظام'} • {new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</small></div></li>)}</ul> : <p className="dashboard-panel-empty">لا توجد أحداث مسجلة لعرضها.</p>}
      </section>
      <section className="panel">
        <div className="panel__header"><div><h2>الوحدات التشغيلية</h2><p>التوزيع الحالي للوحدات النشطة.</p></div><Link to="/admin/units">إدارة الوحدات</Link></div>
        <div className="unit-summary-list">{(['HR', 'ORG', 'AUTH'] as UnitKind[]).map(kind => <div key={kind}><span><Building2 size={19} /></span><div><small>{UNIT_KIND_LABELS[kind]}</small><strong>{units?.[kind] ?? '—'}</strong></div></div>)}</div>
      </section>
    </div>
  </>
}

function dashboardCopy(kind: UnitKind, isManager: boolean): { title: string, subtitle: string } {
  const titles: Record<UnitKind, string> = { HR: 'لوحة متابعة الموارد البشرية', ORG: 'لوحة متابعة التنظيم', AUTH: 'لوحة متابعة السلطة المختصة' }
  return { title: titles[kind], subtitle: isManager ? 'متابعة صندوق المدير والإسناد والمراجعة والقرارات المطلوبة.' : 'متابعة مسؤولياتك والطلبات الجارية والمرتجعة والمكتملة.' }
}

function RequestsTable({ requests }: { requests: WorkflowRequestSummary[] }): React.JSX.Element {
  return <section className="panel dashboard-requests-panel">
    <div className="panel__header"><div><h2>أحدث الطلبات</h2><p>آخر الطلبات الظاهرة ضمن نطاق حسابك.</p></div><Link to="/requests">عرض الكل</Link></div>
    {requests.length === 0 ? <p className="dashboard-panel-empty">لا توجد طلبات متاحة ضمن نطاق حسابك.</p> : <div className="table-scroll"><table className="data-table dashboard-requests-table"><thead><tr><th>رقم الطلب</th><th>النوع</th><th>الوحدة التنظيمية</th><th>المرحلة الحالية</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{requests.map(request => <tr key={request.id}><td><strong className="mono">{request.requestNumber}</strong></td><td>{request.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'}</td><td>{request.routingUnitNameAr ?? request.currentResponsibleUnitName ?? 'لم تحدد بعد'}</td><td>{request.currentStageCode ? STAGE_LABELS[request.currentStageCode] : REQUEST_STATUS_LABELS[request.status]}</td><td><StatusBadge status={request.status} /></td><td><Link className="table-action" to={`/requests/${request.id}`}>عرض الطلب</Link></td></tr>)}</tbody></table></div>}
  </section>
}

function OperationalDashboard({ user }: { user: UserContext }): React.JSX.Element {
  const [myWork, setMyWork] = useState<StageExecutionSummary[]>([])
  const [inbox, setInbox] = useState<ManagerInboxResponse>({ stages: [], rejectedRequests: [] })
  const [requests, setRequests] = useState<WorkflowRequestSummary[]>([])
  const [loaded,setLoaded]=useState(false)
  const [error,setError]=useState<string|null>(null)
  const context = user.operationalContext!
  useEffect(() => {
    void Promise.all([
      workflowApi.myWork(),
      context.isManager ? workflowApi.managerInbox() : Promise.resolve({ stages: [], rejectedRequests: [] }),
      workflowApi.listRequests(0, 8)
    ]).then(([work, managerInbox, recent]) => { setMyWork(work); setInbox(managerInbox); setRequests(recent);setError(null) })
      .catch(requestError=>setError(arabicErrorMessage(requestError))).finally(()=>setLoaded(true))
  }, [context.isManager])
  const correctionWork = useMemo(() => myWork.filter(stage => stage.workState === 'CORRECTION_REQUIRED').length, [myWork])
  const managerWaitingAssignment = inbox.stages.filter(stage => stage.workState === 'MANAGER_INBOX').length
  const managerWaitingReview = inbox.stages.filter(stage => stage.workState === 'MANAGER_REVIEW').length
  const managerCorrections = inbox.stages.filter(stage => stage.workState === 'CORRECTION_REQUIRED').length
  const inProgress = requests.filter(request => request.status === 'DRAFT' || request.status === 'ACTIVE').length
  const completed = requests.filter(request => request.status === 'COMPLETED').length
  const copy = dashboardCopy(context.unitKind, context.isManager)
  if(!loaded||error)return <><DashboardHeading eyebrow={`إيجاس / ${UNIT_KIND_LABELS[context.unitKind]}`} title={copy.title} subtitle={copy.subtitle} />{error?<div className="empty-state"><strong className="error">{error}</strong></div>:<div className="loading-panel"><span className="spinner" /> جارٍ تحميل لوحة المتابعة...</div>}</>
  return <>
    <DashboardHeading eyebrow={`إيجاس / ${UNIT_KIND_LABELS[context.unitKind]}`} title={copy.title} subtitle={copy.subtitle} />
    <div className="metric-grid">{context.isManager ? <>
      <Metric label="صندوق المدير" value={inbox.stages.length + inbox.rejectedRequests.length} details="كل العناصر التي تتطلب تدخلك" icon={Inbox} />
      <Metric label="بانتظار الإسناد" value={managerWaitingAssignment} details="مراحل لم تسند بعد" icon={Users} />
      <Metric label="بانتظار مراجعة المدير" value={managerWaitingReview} details="أعمال رفعها الموظفون" icon={Clock3} tone="warning" />
      <Metric label="مطلوب تصحيح" value={managerCorrections} details="مراحل قيد دورة التصحيح" icon={RotateCcw} tone="danger" />
    </> : <>
      <Metric label="مسؤولياتي" value={myWork.length} details="مراحل مسندة إليك حالياً" icon={ListChecks} />
      <Metric label="طلبات قيد الإجراء" value={inProgress} details="مسودات وطلبات نشطة" icon={Clock3} tone="warning" />
      <Metric label="طلبات مرتجعة" value={correctionWork} details="مطلوب تصحيحها" icon={RotateCcw} tone="danger" />
      <Metric label="طلبات مكتملة" value={completed} details="ضمن أحدث الطلبات" icon={CheckCircle2} tone="success" />
    </>}</div>
    {context.unitKind === 'HR' && <div className="dashboard-create-action"><Link className="button button--primary" to="/requests/new"><Plus size={20} /> طلب جديد</Link></div>}
    <RequestsTable requests={requests} />
  </>
}

export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth()
  if (!user) return <EmptyState icon={Users} title="غير مسجل الدخول" body="يرجى تسجيل الدخول للمتابعة." action={{ to: '/login', label: 'تسجيل الدخول' }} />
  return <div className="page-stack dashboard-page">{user.accountType === 'ADMIN' ? <AdminDashboard /> : user.operationalContext ? <OperationalDashboard user={user} /> : <EmptyState icon={CircleAlert} title="لا توجد عضوية تشغيلية نشطة" body="حسابك تشغيلي لكنه لا ينتمي لوحدة تشغيلية حالياً. راجع إدارة النظام." />}</div>
}

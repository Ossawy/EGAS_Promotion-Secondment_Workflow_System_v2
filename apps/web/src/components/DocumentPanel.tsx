import { useEffect, useState } from 'react'
import { Download, Eye, FileClock, FileDown, FileText, Printer } from 'lucide-react'
import { apiRequest } from '../api/client'
import type { RequestDocuments, WorkflowRequestDetail } from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'

function date(value: string): string {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function PdfLink({ href, download, children }: { href: string, download?: boolean, children: React.ReactNode }): React.JSX.Element {
  return <a className={download ? 'button button--secondary' : 'button button--primary'} href={`${href}${download ? '?download=1' : ''}`}
    target="_blank" rel="noreferrer">{download ? <Download size={16} /> : <Eye size={16} />}{children}</a>
}

export function DocumentPanel({ detail }: { detail: WorkflowRequestDetail }): React.JSX.Element {
  const { user } = useAuth()
  const [documents, setDocuments] = useState<RequestDocuments | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    apiRequest<RequestDocuments>(`/api/workflow/requests/${detail.id}/documents`)
      .then(value => { if (active) setDocuments(value) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [detail.id, detail.currentStage, detail.currentIterationNo])

  return <section className="panel document-panel">
    <div className="panel__header"><div><h2>المستندات الرسمية</h2><p>المسودة تعكس البيانات الحالية، أما نسخ الاستلام والنسخة النهائية فهي أدلة ثابتة.</p></div><FileText size={23} /></div>
    {error && <p className="error" role="alert">تعذر تحميل قائمة المستندات.</p>}
    <div className="document-actions">
      <article><FileDown /><div><strong>مسودة العمل الحالية</strong><span>تُولد عند الطلب وقد تتغير مع الحفظ.</span></div><PdfLink href={`/api/workflow/requests/${detail.id}/pdf/draft`}>عرض كـ PDF</PdfLink></article>
      {documents?.finalAvailable && <article className="document-final"><Printer /><div><strong>النسخة النهائية المجمدة</strong><span>بيانات الاعتماد النهائي غير قابلة لإعادة الكتابة.</span></div><span className="document-buttons"><PdfLink href={`/api/workflow/requests/${detail.id}/pdf/final`}>عرض / طباعة</PdfLink><PdfLink download href={`/api/workflow/requests/${detail.id}/pdf/final`}>تنزيل</PdfLink></span></article>}
      {user?.activeRole === 'EMPLOYEE_AFFAIRS' && <article><FileClock /><div><strong>سجل التدقيق الكامل</strong><span>مستند منفصل عن النموذج الرسمي.</span></div><PdfLink href={`/api/workflow/requests/${detail.id}/pdf/audit`}>عرض سجل التدقيق</PdfLink></article>}
    </div>
    {documents && documents.received.length > 0 && <div className="received-documents"><h3>نسخ المهام كما استلمتها</h3>{documents.received.map(item => <article key={item.snapshotId}>
      <span className="stage-chip">{item.stageCode}</span><div><strong>الدورة {item.iterationNo}</strong><small>{date(item.receivedAt)}</small></div>
      <span className="document-buttons"><PdfLink href={`/api/workflow/requests/${detail.id}/pdf/received/${item.snapshotId}`}>عرض كـ PDF</PdfLink><PdfLink download href={`/api/workflow/requests/${detail.id}/pdf/received/${item.snapshotId}`}>تنزيل</PdfLink></span>
    </article>)}</div>}
  </section>
}

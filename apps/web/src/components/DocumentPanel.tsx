import { Download, FileText, Printer } from 'lucide-react'
import type { WorkflowRequestSummary } from '../api/workflow-types'
import { documentUrl } from '../api/endpoints'

/** Current/final/audit official PDFs. The server enforces authorization per document kind. */
export function DocumentPanel({ request }: { request: WorkflowRequestSummary }): React.JSX.Element {
  return (
    <section className="card" aria-label="المستندات الرسمية">
      <h2>المستندات</h2>
      <div className="document-links">
        <a className="button button--secondary" href={documentUrl(request.id, 'current')} target="_blank" rel="noopener noreferrer">
          <FileText size={17} aria-hidden="true" /> عرض النموذج الحالي (PDF)
        </a>
        <a className="button button--secondary" href={documentUrl(request.id, 'audit')} target="_blank" rel="noopener noreferrer">
          <Download size={17} aria-hidden="true" /> تقرير التدقيق (PDF)
        </a>
        {request.status === 'COMPLETED' && (
          <>
            <a className="button button--primary" href={documentUrl(request.id, 'final')} target="_blank" rel="noopener noreferrer">
              <FileText size={17} aria-hidden="true" /> النسخة الرسمية المعتمدة (PDF)
            </a>
            <a className="button button--secondary" href={documentUrl(request.id, 'final')} target="_blank" rel="noopener noreferrer">
              <Printer size={17} aria-hidden="true" /> فتح للطباعة
            </a>
          </>
        )}
      </div>
      {request.status !== 'COMPLETED' && (
        <p className="muted">تُتاح النسخة الرسمية المجمّدة بعد اكتمال الطلب نهائياً.</p>
      )}
    </section>
  )
}

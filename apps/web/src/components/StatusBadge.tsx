const labels: Record<string, string> = {
  DRAFT: 'مسودة',
  IN_PROGRESS: 'قيد الإجراء',
  RETURNED: 'مرتجع للتصحيح',
  COMPLETED: 'مكتمل',
  CANCELLED: 'ملغي',
  OPEN: 'متاح',
  CLAIMED: 'تم الاستلام'
}

function tone(status: string): string {
  if (status === 'COMPLETED') return 'success'
  if (status === 'RETURNED' || status === 'CANCELLED') return 'danger'
  if (status === 'DRAFT') return 'neutral'
  if (status === 'IN_PROGRESS' || status === 'CLAIMED') return 'info'
  return 'warning'
}

export function StatusBadge({ status, label }: { status: string, label?: string }): React.JSX.Element {
  return <span className={`status-badge status-badge--${tone(status)}`}>
    <span aria-hidden="true" />
    {label ?? labels[status] ?? status}
  </span>
}

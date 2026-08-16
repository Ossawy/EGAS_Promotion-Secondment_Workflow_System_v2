import type { LucideIcon } from 'lucide-react'

export function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon, title: string, body: string }): React.JSX.Element {
  return <div className="empty-state">
    <span className="empty-state__icon" aria-hidden="true"><Icon size={28} /></span>
    <h3>{title}</h3>
    <p>{body}</p>
  </div>
}

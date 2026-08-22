import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'

export function EmptyState({ icon: Icon, title, body, action }: {
  icon: LucideIcon
  title: string
  body: string
  action?: { to: string, label: string }
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true"><Icon size={28} /></span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action && <Link className="button button--primary" to={action.to}>{action.label}</Link>}
    </div>
  )
}

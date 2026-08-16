import { Building2 } from 'lucide-react'

export function BrandMark({ compact = false, light = false }: { compact?: boolean, light?: boolean }): React.JSX.Element {
  return <div className={`brand-mark${light ? ' brand-mark--light' : ''}${compact ? ' brand-mark--compact' : ''}`}>
    <span className="brand-mark__symbol" aria-hidden="true"><Building2 size={compact ? 22 : 30} strokeWidth={1.7} /></span>
    <span>
      <strong>إيجاس</strong>
      {!compact && <small>الشركة المصرية القابضة للغازات الطبيعية</small>}
    </span>
  </div>
}

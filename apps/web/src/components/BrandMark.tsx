import egasLogo from '../assets/egas-logo.png'

export function BrandMark({
  compact = false,
  light = false
}: {
  compact?: boolean
  light?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`brand-mark${light ? ' brand-mark--light' : ''}${compact ? ' brand-mark--compact' : ''}`}
    >
      <span className="brand-mark__symbol" aria-hidden="true">
        <img
          src={egasLogo}
          alt=""
          className="brand-mark__logo"
        />
      </span>

      <span>
        <strong>إيجاس</strong>
        {!compact && (
          <small>الشركة المصرية القابضة للغازات الطبيعية</small>
        )}
      </span>
    </div>
  )
}
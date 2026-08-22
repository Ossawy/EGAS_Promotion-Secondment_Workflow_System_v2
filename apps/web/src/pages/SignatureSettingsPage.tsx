import { SignatureAssetsPanel } from '../components/SignatureAssetsPanel'

export function SignatureSettingsPage(): React.JSX.Element {
  return (
    <div className="page-stack narrow">
      <header className="page-header"><div><h1>إعدادات أصل التوقيع</h1><p className="muted">إعداد في ملفك الشخصي، وليس إجراء اعتماد لطلب.</p></div></header>
      <SignatureAssetsPanel />
    </div>
  )
}

import type { PropsWithChildren, ReactNode } from 'react'
import { BrandMark } from './BrandMark'

type AuthLayoutProps = PropsWithChildren<{
  title: string
  subtitle: string
  eyebrow?: string
  footer?: ReactNode
}>

export function AuthLayout({ title, subtitle, eyebrow, footer, children }: AuthLayoutProps): React.JSX.Element {
  return <main className="auth-page">
    <div className="auth-page__overlay" aria-hidden="true" />
    <section className="auth-page__content">
      <BrandMark light />
      <p className="auth-page__product">نظام إدارة مسارات عمل الموارد البشرية</p>
      <div className="auth-panel">
        {eyebrow && <p className="auth-panel__eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="auth-panel__subtitle">{subtitle}</p>
        {children}
      </div>
      <p className="auth-page__footer">{footer ?? '© الشركة المصرية القابضة للغازات الطبيعية (إيجاس). جميع الحقوق محفوظة.'}</p>
    </section>
  </main>
}

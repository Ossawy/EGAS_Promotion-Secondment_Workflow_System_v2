import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AppConfig } from '../../config/env.ts'

export function fingerprintIdentifier(value: string, config: AppConfig): string {
  return createHmac('sha256', config.auth.fingerprintSecret)
    .update(value.trim().toLocaleLowerCase('en-US'), 'utf8')
    .digest('hex')
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

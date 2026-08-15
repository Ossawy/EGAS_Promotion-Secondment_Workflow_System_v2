export const BASE_REQUIRED_HEADERS = [
  'رقم الموظف',
  'اسم الموظف',
  'المجموعة الفرعية',
  'النيابة / المساعد',
  'الوظيفة',
  'المؤسسة التعليمية-المؤهل الاصلي',
  'الشهادة-المؤهل الاصلي',
  'تاريخ المؤهل الاصلي'
] as const

export interface HeaderValidationResult {
  valid: boolean
  normalizedHeaders: string[]
  missing: string[]
  duplicates: string[]
  unexpected: string[]
}

export function requiredHeadersForYear(year: number): string[] {
  const configured = process.env.EGAS_IMPORT_PERFORMANCE_HEADER?.trim()
  if (configured) return [...BASE_REQUIRED_HEADERS, configured]
  if (year === 2026) return [...BASE_REQUIRED_HEADERS, 'تقرير كفاية2026']

  throw new Error(
    'The approved performance-report header is not defined for this year. ' +
    'Set EGAS_IMPORT_PERFORMANCE_HEADER to the exact EGAS-approved header name.'
  )
}

export function validateHeaders(
  headers: readonly unknown[],
  requiredHeaders: readonly string[]
): HeaderValidationResult {
  const normalizedHeaders = headers
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)

  const counts = new Map<string, number>()
  for (const header of normalizedHeaders) {
    counts.set(header, (counts.get(header) ?? 0) + 1)
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([header]) => header)
    .sort()
  const missing = requiredHeaders
    .filter(header => !counts.has(header))
    .sort()
  const required = new Set(requiredHeaders)
  const unexpected = normalizedHeaders
    .filter(header => !required.has(header))

  return {
    valid: missing.length === 0 && duplicates.length === 0,
    normalizedHeaders,
    missing,
    duplicates,
    unexpected
  }
}

export function normalizeNullableSentinel(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized === '' || normalized === '10' ? null : normalized
}

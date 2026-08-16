export const IMPORT_HEADERS = {
  personnelNumber: 'رقم الموظف',
  employeeName: 'اسم الموظف',
  subgroup: 'المجموعة الفرعية',
  routingUnit: 'النيابة /المساعد',
  currentJobTitle: 'الوظيفة',
  qualificationSource1: 'المؤسسة التعليمية-المؤهل الاصلي',
  qualificationSource2: 'الشهادة-المؤهل الاصلي',
  qualificationDate: 'تاريخ المؤهل الاصلي'
} as const

export type ImportField = keyof typeof IMPORT_HEADERS | 'performanceRating'
export const BASE_REQUIRED_HEADERS = Object.values(IMPORT_HEADERS)

export interface HeaderValidationResult {
  valid: boolean
  normalizedHeaders: string[]
  missing: string[]
  duplicates: string[]
  unexpected: string[]
}

function compareHeader(left: string, right: string): number {
  return left.localeCompare(right)
}

function supportedScalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  throw new TypeError('Unsupported workbook value type')
}

export function performanceHeaderForYear(year: number): string {
  const configured = process.env.EGAS_IMPORT_PERFORMANCE_HEADER?.trim()
  if (configured) return configured
  if (year === 2026) return 'تقرير كفاية 2026'
  throw new Error(
    'The approved performance-report header is not defined for this year. Set EGAS_IMPORT_PERFORMANCE_HEADER to the exact EGAS-approved header name.'
  )
}

export function requiredHeadersForYear(year: number): string[] {
  return [...BASE_REQUIRED_HEADERS, performanceHeaderForYear(year)]
}

export function headerForField(field: ImportField, year: number): string {
  return field === 'performanceRating' ? performanceHeaderForYear(year) : IMPORT_HEADERS[field]
}

export function normalizeHeader(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function validateHeaders(headers: readonly unknown[], requiredHeaders: readonly string[]): HeaderValidationResult {
  const normalizedHeaders = headers.map(normalizeHeader).filter(Boolean)
  const counts = new Map<string, number>()
  for (const header of normalizedHeaders) counts.set(header, (counts.get(header) ?? 0) + 1)
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([header]) => header)
    .sort(compareHeader)
  const missing = requiredHeaders.filter(header => !counts.has(header)).sort(compareHeader)
  const required = new Set(requiredHeaders)
  return {
    valid: missing.length === 0 && duplicates.length === 0,
    normalizedHeaders,
    missing,
    duplicates,
    unexpected: normalizedHeaders.filter(header => !required.has(header))
  }
}

export function normalizeNullableSentinel(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const normalized = supportedScalarText(value).trim()
  return normalized === '' || normalized === '10' ? null : normalized
}

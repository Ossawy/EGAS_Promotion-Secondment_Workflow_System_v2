import { headerForField } from './header-validation.ts'
import type { SourceWorkbookRow, WorkbookCell } from './workbook-inspector.ts'

export type ValidationStatus = 'VALID' | 'WARNING' | 'BLOCKED'
export type ValidationSeverity = 'WARNING' | 'BLOCKING'
export type NormalizedQualificationDate =
  | { kind: 'VALID', value: string }
  | { kind: 'EMPTY', value: null }
  | { kind: 'INVALID' }

export interface ValidationMessage {
  code: string
  severity: ValidationSeverity
  field: string
  message: string
}

export interface RoutingTarget { id: string, nameAr: string }
export interface RoutingIndex {
  unitsByName: ReadonlyMap<string, RoutingTarget>
  aliasesByLabel: ReadonlyMap<string, RoutingTarget>
}

export interface NormalizedStagingRow {
  id?: string
  sourceRowNumber: number
  raw: Record<string, string | number | boolean | null>
  personnelNumber: string | null
  employeeName: string | null
  subgroup: string | null
  sourceRoutingUnit: string | null
  currentJobTitle: string | null
  performanceRating: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
  mappedRoutingUnitId: string | null
  validationStatus: ValidationStatus
  validationMessages: ValidationMessage[]
}

const APPROVED_PERFORMANCE_RATINGS = new Set(['ممتاز', 'جيد جدا', 'جيد'])

function approvedPerformanceRating(value: string | null): string | null {
  return value !== null && APPROVED_PERFORMANCE_RATINGS.has(value) ? value : null
}

function text(value: WorkbookCell | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value instanceof Date ? value.toISOString() : String(value).trim()
  return normalized === '' ? null : normalized
}

function nullableSentinel(value: WorkbookCell | undefined): string | null {
  const normalized = text(value)
  return normalized === '10' ? null : normalized
}

function issue(
  messages: ValidationMessage[], code: string, severity: ValidationSeverity, field: string, message: string
): void {
  messages.push({ code, severity, field, message })
}

function bounded(
  value: string | null, maximum: number, field: string, messages: ValidationMessage[], required = false
): string | null {
  if (value === null) {
    if (required) issue(messages, `${field.toUpperCase()}_REQUIRED`, 'BLOCKING', field, `${field} is required`)
    return null
  }
  if (value.length > maximum) {
    issue(messages, `${field.toUpperCase()}_TOO_LONG`, 'BLOCKING', field, `${field} exceeds ${maximum} characters`)
    return null
  }
  return value
}

function excelSerialDate(value: number): string | null {
  if (!Number.isFinite(value) || value < 1 || value > 2_958_465) return null
  const milliseconds = Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000
  const parsed = new Date(milliseconds)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function calendarDate(year: number, month: number, day: number): string | null {
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return parsed.toISOString().slice(0, 10)
}

function validDate(value: string): NormalizedQualificationDate {
  return { kind: 'VALID', value }
}

function parsedDate(value: string | null): NormalizedQualificationDate {
  return value === null ? { kind: 'INVALID' } : validDate(value)
}

export function normalizeQualificationDate(value: WorkbookCell | undefined): NormalizedQualificationDate {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { kind: 'EMPTY', value: null }
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { kind: 'INVALID' }
      : validDate(value.toISOString().slice(0, 10))
  }

  if (typeof value === 'number') {
    return parsedDate(excelSerialDate(value))
  }

  const normalized = String(value).trim()

  // Dates stored in rawjson are serialized using Date.toISOString().
  // Revalidation must accept that same ISO UTC representation.
  const isoDateTime =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.exec(normalized)

  if (isoDateTime) {
    return parsedDate(
      calendarDate(
        Number(isoDateTime[1]),
        Number(isoDateTime[2]),
        Number(isoDateTime[3])
      )
    )
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [year, month, day] = normalized.split('-').map(Number) as [number, number, number]
    return parsedDate(calendarDate(year, month, day))
  }

  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(normalized)

  if (dayFirst) {
    return parsedDate(
      calendarDate(
        Number(dayFirst[3]),
        Number(dayFirst[2]),
        Number(dayFirst[1])
      )
    )
  }

  return { kind: 'INVALID' }
}

function status(messages: readonly ValidationMessage[]): ValidationStatus {
  if (messages.some(message => message.severity === 'BLOCKING')) return 'BLOCKED'
  if (messages.length) return 'WARNING'
  return 'VALID'
}

export function normalizeStagingRow(source: SourceWorkbookRow, year: number, routing: RoutingIndex): NormalizedStagingRow {
  const messages: ValidationMessage[] = []
  const read = (field: Parameters<typeof headerForField>[0]): WorkbookCell | undefined =>
    source.values.get(headerForField(field, year))

  const personnelNumber = bounded(text(read('personnelNumber')), 120, 'personnelNumber', messages, true)
  const employeeName = bounded(text(read('employeeName')), 300, 'employeeName', messages, true)
  const subgroup = bounded(text(read('subgroup')), 200, 'subgroup', messages)
  const sourceRoutingUnit = bounded(nullableSentinel(read('routingUnit')), 300, 'sourceRoutingUnit', messages)
  const currentJobTitle = bounded(text(read('currentJobTitle')), 500, 'currentJobTitle', messages)
  const qualificationSource1 = bounded(text(read('qualificationSource1')), 500, 'qualificationSource1', messages)
  const qualificationSource2 = bounded(text(read('qualificationSource2')), 500, 'qualificationSource2', messages)

  const performanceRating = bounded(nullableSentinel(read('performanceRating')), 40, 'performanceRating', messages)
  if (performanceRating !== null && !APPROVED_PERFORMANCE_RATINGS.has(performanceRating)) {
    issue(messages, 'PERFORMANCE_UNKNOWN', 'BLOCKING', 'performanceRating', 'Performance rating is not an approved value')
  } else if (performanceRating === 'جيد') {
    issue(messages, 'PERFORMANCE_GOOD_WARNING', 'WARNING', 'performanceRating', 'Performance rating requires a workflow warning')
  } else if (performanceRating === null) {
    issue(messages, 'PERFORMANCE_MISSING', 'WARNING', 'performanceRating', 'Performance rating is unavailable')
  }

  const date = normalizeQualificationDate(read('qualificationDate'))
  const qualificationDate = date.kind === 'VALID' ? date.value : null
  if (date.kind === 'INVALID') {
    issue(messages, 'QUALIFICATION_DATE_INVALID', 'BLOCKING', 'qualificationDate', 'Qualification date is invalid')
  }

  let mappedRoutingUnitId: string | null = null
  if (sourceRoutingUnit === null) {
    issue(messages, 'ROUTING_REQUIRED', 'BLOCKING', 'sourceRoutingUnit', 'Routing label is required')
  } else {
    const target = routing.unitsByName.get(sourceRoutingUnit) ?? routing.aliasesByLabel.get(sourceRoutingUnit)
    if (target) mappedRoutingUnitId = target.id
    else issue(messages, 'ROUTING_UNMAPPED', 'BLOCKING', 'sourceRoutingUnit', 'Routing label has no approved active mapping')
  }

  return {
    sourceRowNumber: source.sourceRowNumber,
    raw: source.raw,
    personnelNumber,
    employeeName,
    subgroup,
    sourceRoutingUnit,
    currentJobTitle,
    performanceRating: approvedPerformanceRating(performanceRating),
    qualificationSource1,
    qualificationSource2,
    qualificationDate,
    mappedRoutingUnitId,
    validationStatus: status(messages),
    validationMessages: messages
  }
}

export function applyDuplicatePersonnelValidation(rows: NormalizedStagingRow[]): void {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.personnelNumber) counts.set(row.personnelNumber, (counts.get(row.personnelNumber) ?? 0) + 1)
  }
  for (const row of rows) {
    if (!row.personnelNumber || (counts.get(row.personnelNumber) ?? 0) < 2) continue
    row.validationMessages.push({
      code: 'PERSONNEL_NUMBER_DUPLICATE', severity: 'BLOCKING', field: 'personnelNumber',
      message: 'Personnel Number is duplicated within this import batch'
    })
    row.validationStatus = 'BLOCKED'
  }
}

export function rowsFromStoredRaw(
  rows: Array<{ sourceRowNumber: number, raw: Record<string, string | number | boolean | null> }>
): SourceWorkbookRow[] {
  return rows.map(row => ({
    sourceRowNumber: row.sourceRowNumber,
    raw: row.raw,
    values: new Map(Object.entries(row.raw))
  }))
}

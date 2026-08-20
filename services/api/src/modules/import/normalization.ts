import { normalizeRoutingLabel, type ImportSemanticField } from './header-validation.ts'
import type { SourceWorkbookRow, WorkbookCell } from './workbook-inspector.ts'

export type ValidationStatus = 'VALID' | 'WARNING' | 'BLOCKED'
export type ValidationSeverity = 'WARNING' | 'BLOCKING'

export type NormalizedDateResult =
  | { kind: 'VALID', value: string }
  | { kind: 'EMPTY', value: null }
  | { kind: 'INVALID' }

export type NormalizedIntegerResult =
  | { kind: 'VALID', value: number }
  | { kind: 'EMPTY', value: null }
  | { kind: 'INVALID' }

export interface ValidationMessage {
  code: string
  severity: ValidationSeverity
  field: string
  message: string
}

export interface RoutingTarget {
  id: string
  nameAr: string
}

export interface RoutingIndex {
  targetsByNormalizedLabel: ReadonlyMap<string, RoutingTarget[]>
}

export interface NormalizedStagingRow {
  id?: string
  sourceRowNumber: number
  raw: Record<string, string | number | boolean | null>
  sourceOrder: string | null
  personnelNumber: string | null
  employeeName: string | null
  employeeGroup: string | null
  subgroup: string | null
  sourceRoutingUnit: string | null
  currentJobTitle: string | null
  lastPromotionDate: string | null
  experienceStartDate: string | null
  performanceRating: string | null
  performanceReportYear: number
  joiningDate: string | null
  experienceYears: number | null
  experienceMonths: number | null
  experienceDays: number | null
  experienceReferenceDate: string
  currentJobStartDate: string | null
  currentJobTenureYears: number | null
  currentJobTenureMonths: number | null
  currentJobTenureDays: number | null
  currentJobTenureReferenceDate: string
  originalQualificationSource: string | null
  originalQualificationCertificate: string | null
  originalQualificationDate: string | null
  mappedRoutingUnitId: string | null
  validationStatus: ValidationStatus
  validationMessages: ValidationMessage[]
}

const APPROVED_PERFORMANCE_RATINGS = new Set(['ممتاز', 'جيد جدا', 'جيد'])

function cleanGenericText(value: WorkbookCell | undefined): string | null {
  if (value === null || value === undefined) return null
  const str = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim()
  return str === '' ? null : str
}

function cleanPerformanceRating(value: WorkbookCell | undefined): string | null {
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  if (str === '' || str === '10' || str === '-' || str === '—') return null
  return str
}

function issue(
  messages: ValidationMessage[],
  code: string,
  severity: ValidationSeverity,
  field: string,
  message: string
): void {
  messages.push({ code, severity, field, message })
}

function boundedText(
  value: string | null,
  maximum: number,
  field: string,
  messages: ValidationMessage[],
  required = false
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
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return parsed.toISOString().slice(0, 10)
}

export function normalizeDateValue(value: WorkbookCell | undefined): NormalizedDateResult {
  if (value === null || value === undefined) {
    return { kind: 'EMPTY', value: null }
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { kind: 'INVALID' }
      : { kind: 'VALID', value: value.toISOString().slice(0, 10) }
  }

  if (typeof value === 'number') {
    const serial = excelSerialDate(value)
    return serial ? { kind: 'VALID', value: serial } : { kind: 'INVALID' }
  }

  const str = String(value).trim()
  if (str === '' || str === '-' || str === '—') {
    return { kind: 'EMPTY', value: null }
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(str)
  if (isoMatch) {
    const valid = calendarDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
    return valid ? { kind: 'VALID', value: valid } : { kind: 'INVALID' }
  }

  const slashMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(str)
  if (slashMatch) {
    const valid = calendarDate(Number(slashMatch[3]), Number(slashMatch[2]), Number(slashMatch[1]))
    return valid ? { kind: 'VALID', value: valid } : { kind: 'INVALID' }
  }

  const yearSlashMatch = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(str)
  if (yearSlashMatch) {
    const valid = calendarDate(Number(yearSlashMatch[1]), Number(yearSlashMatch[2]), Number(yearSlashMatch[3]))
    return valid ? { kind: 'VALID', value: valid } : { kind: 'INVALID' }
  }

  return { kind: 'INVALID' }
}

export function parseDurationInteger(value: WorkbookCell | undefined): NormalizedIntegerResult {
  if (value === null || value === undefined) {
    return { kind: 'EMPTY', value: null }
  }

  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return { kind: 'VALID', value }
    }
    return { kind: 'INVALID' }
  }

  const str = String(value).trim()
  if (str === '' || str === '-' || str === '—') {
    return { kind: 'EMPTY', value: null }
  }

  if (/^\d+$/.test(str)) {
    const num = Number(str)
    if (Number.isSafeInteger(num) && num >= 0) {
      return { kind: 'VALID', value: num }
    }
  }

  return { kind: 'INVALID' }
}

function calculateDateDiff(startDateStr: string, endDateStr: string): { years: number, months: number, days: number } | null {
  const start = new Date(startDateStr + 'T00:00:00Z')
  const end = new Date(endDateStr + 'T00:00:00Z')
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null

  let years = end.getUTCFullYear() - start.getUTCFullYear()
  let months = end.getUTCMonth() - start.getUTCMonth()
  let days = end.getUTCDate() - start.getUTCDate()

  if (days < 0) {
    months -= 1
    const prevMonthLastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)).getUTCDate()
    days += prevMonthLastDay
  }
  if (months < 0) {
    years -= 1
    months += 12
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) }
}

function determineRowStatus(messages: readonly ValidationMessage[]): ValidationStatus {
  if (messages.some(message => message.severity === 'BLOCKING')) return 'BLOCKED'
  if (messages.length > 0) return 'WARNING'
  return 'VALID'
}

export function normalizeStagingRow(
  source: SourceWorkbookRow,
  snapshotYear: number,
  routing: RoutingIndex
): NormalizedStagingRow {
  const messages: ValidationMessage[] = []
  const read = (field: ImportSemanticField): WorkbookCell | undefined => source.values.get(field)

  // 1. Source order / index
  const sourceOrder = boundedText(cleanGenericText(read('sourceOrder')), 50, 'sourceOrder', messages)

  // 2. Personnel number (Required)
  const personnelNumber = boundedText(cleanGenericText(read('personnelNumber')), 120, 'personnelNumber', messages, true)

  // 3. Employee name (Required)
  const employeeName = boundedText(cleanGenericText(read('employeeName')), 300, 'employeeName', messages, true)

  // 4. Employee group
  const employeeGroup = boundedText(cleanGenericText(read('employeeGroup')), 200, 'employeeGroup', messages)

  // 5. Subgroup
  const subgroup = boundedText(cleanGenericText(read('subgroup')), 200, 'subgroup', messages)

  // 6. Source routing unit (Required)
  const rawRoutingUnit = cleanGenericText(read('sourceRoutingUnit'))
  const sourceRoutingUnit = boundedText(rawRoutingUnit, 300, 'sourceRoutingUnit', messages, true)

  // 7. Current job title
  const currentJobTitle = boundedText(cleanGenericText(read('currentJobTitle')), 500, 'currentJobTitle', messages)

  // 8. Last promotion seniority date
  const lastPromoRes = normalizeDateValue(read('lastPromotionDate'))
  const lastPromotionDate = lastPromoRes.kind === 'VALID' ? lastPromoRes.value : null
  if (lastPromoRes.kind === 'INVALID') {
    issue(messages, 'LAST_PROMOTION_DATE_INVALID', 'BLOCKING', 'lastPromotionDate', 'Last promotion date is invalid')
  }

  // 9. Experience start date
  const expStartRes = normalizeDateValue(read('experienceStartDate'))
  const experienceStartDate = expStartRes.kind === 'VALID' ? expStartRes.value : null
  if (expStartRes.kind === 'INVALID') {
    issue(messages, 'EXPERIENCE_START_DATE_INVALID', 'BLOCKING', 'experienceStartDate', 'Experience start date is invalid')
  }

  // 10. Performance rating (explicit sentinel 10 -> null with warning)
  const rawPerf = cleanPerformanceRating(read('performanceRating'))
  let performanceRating: string | null = null
  if (rawPerf === null) {
    issue(messages, 'PERFORMANCE_MISSING', 'WARNING', 'performanceRating', 'Performance rating is unavailable')
  } else if (!APPROVED_PERFORMANCE_RATINGS.has(rawPerf)) {
    issue(messages, 'PERFORMANCE_UNKNOWN', 'BLOCKING', 'performanceRating', `Performance rating "${rawPerf}" is not an approved value`)
  } else {
    performanceRating = rawPerf
  }

  // 11. Joining date
  const joinRes = normalizeDateValue(read('joiningDate'))
  const joiningDate = joinRes.kind === 'VALID' ? joinRes.value : null
  if (joinRes.kind === 'INVALID') {
    issue(messages, 'JOINING_DATE_INVALID', 'BLOCKING', 'joiningDate', 'Joining date is invalid')
  }

  // 12-14. Experience duration triplet (Preserve detected reference date)
  const experienceReferenceDate = source.experienceReferenceDate ?? `${snapshotYear}-01-01`
  const expYearsRes = parseDurationInteger(read('experienceYears'))
  const expMonthsRes = parseDurationInteger(read('experienceMonths'))
  const expDaysRes = parseDurationInteger(read('experienceDays'))

  if (expYearsRes.kind === 'INVALID') {
    issue(messages, 'EXPERIENCE_YEARS_INVALID', 'BLOCKING', 'experienceYears', 'Experience years duration value is invalid')
  }
  if (expMonthsRes.kind === 'INVALID') {
    issue(messages, 'EXPERIENCE_MONTHS_INVALID', 'BLOCKING', 'experienceMonths', 'Experience months duration value is invalid')
  }
  if (expDaysRes.kind === 'INVALID') {
    issue(messages, 'EXPERIENCE_DAYS_INVALID', 'BLOCKING', 'experienceDays', 'Experience days duration value is invalid')
  }

  const experienceYears = expYearsRes.kind === 'VALID' ? expYearsRes.value : null
  const experienceMonths = expMonthsRes.kind === 'VALID' ? expMonthsRes.value : null
  const experienceDays = expDaysRes.kind === 'VALID' ? expDaysRes.value : null

  if (experienceStartDate && experienceYears !== null) {
    const calc = calculateDateDiff(experienceStartDate, experienceReferenceDate)
    if (calc && Math.abs(calc.years - experienceYears) > 1) {
      issue(
        messages,
        'EXPERIENCE_DURATION_INCONSISTENCY',
        'WARNING',
        'experienceYears',
        `Calculated experience (${calc.years}y) differs from workbook experience (${experienceYears}y)`
      )
    }
  }

  // 15-17. Job tenure duration triplet (Preserve detected reference date)
  const currentJobTenureReferenceDate = source.currentJobTenureReferenceDate ?? `${snapshotYear}-07-01`
  const tenureYearsRes = parseDurationInteger(read('currentJobTenureYears'))
  const tenureMonthsRes = parseDurationInteger(read('currentJobTenureMonths'))
  const tenureDaysRes = parseDurationInteger(read('currentJobTenureDays'))

  if (tenureYearsRes.kind === 'INVALID') {
    issue(messages, 'TENURE_YEARS_INVALID', 'BLOCKING', 'currentJobTenureYears', 'Current job tenure years duration value is invalid')
  }
  if (tenureMonthsRes.kind === 'INVALID') {
    issue(messages, 'TENURE_MONTHS_INVALID', 'BLOCKING', 'currentJobTenureMonths', 'Current job tenure months duration value is invalid')
  }
  if (tenureDaysRes.kind === 'INVALID') {
    issue(messages, 'TENURE_DAYS_INVALID', 'BLOCKING', 'currentJobTenureDays', 'Current job tenure days duration value is invalid')
  }

  const currentJobTenureYears = tenureYearsRes.kind === 'VALID' ? tenureYearsRes.value : null
  const currentJobTenureMonths = tenureMonthsRes.kind === 'VALID' ? tenureMonthsRes.value : null
  const currentJobTenureDays = tenureDaysRes.kind === 'VALID' ? tenureDaysRes.value : null

  // 18. Qualification Institution
  const originalQualificationSource = boundedText(cleanGenericText(read('qualificationSource1')), 500, 'qualificationSource1', messages)

  // 19. Qualification Certificate
  const originalQualificationCertificate = boundedText(cleanGenericText(read('qualificationSource2')), 500, 'qualificationSource2', messages)

  // 20. Qualification Date
  const qualDateRes = normalizeDateValue(read('qualificationDate'))
  const originalQualificationDate = qualDateRes.kind === 'VALID' ? qualDateRes.value : null
  if (qualDateRes.kind === 'INVALID') {
    issue(messages, 'QUALIFICATION_DATE_INVALID', 'BLOCKING', 'qualificationDate', 'Qualification date is invalid')
  }

  // 21. Current job start date
  const jobStartRes = normalizeDateValue(read('currentJobStartDate'))
  const currentJobStartDate = jobStartRes.kind === 'VALID' ? jobStartRes.value : null
  if (jobStartRes.kind === 'INVALID') {
    issue(messages, 'CURRENT_JOB_START_DATE_INVALID', 'BLOCKING', 'currentJobStartDate', 'Current job start date is invalid')
  }

  if (currentJobStartDate && currentJobTenureYears !== null) {
    const calc = calculateDateDiff(currentJobStartDate, currentJobTenureReferenceDate)
    if (calc && Math.abs(calc.years - currentJobTenureYears) > 1) {
      issue(
        messages,
        'TENURE_DURATION_INCONSISTENCY',
        'WARNING',
        'currentJobTenureYears',
        `Calculated tenure (${calc.years}y) differs from workbook tenure (${currentJobTenureYears}y)`
      )
    }
  }

  // Routing resolution
  let mappedRoutingUnitId: string | null = null
  if (sourceRoutingUnit) {
    const normalizedKey = normalizeRoutingLabel(sourceRoutingUnit)
    const targets = routing.targetsByNormalizedLabel.get(normalizedKey) ?? []

    if (targets.length === 0) {
      issue(
        messages,
        'ROUTING_UNMAPPED',
        'BLOCKING',
        'sourceRoutingUnit',
        `Routing label "${sourceRoutingUnit}" has no approved active mapping`
      )
    } else if (targets.length > 1) {
      issue(
        messages,
        'ROUTING_AMBIGUOUS',
        'BLOCKING',
        'sourceRoutingUnit',
        `Routing label "${sourceRoutingUnit}" maps ambiguously to ${targets.length} routing units`
      )
    } else {
      mappedRoutingUnitId = targets[0]!.id
    }
  }

  return {
    sourceRowNumber: source.sourceRowNumber,
    raw: source.raw,
    sourceOrder,
    personnelNumber,
    employeeName,
    employeeGroup,
    subgroup,
    sourceRoutingUnit,
    currentJobTitle,
    lastPromotionDate,
    experienceStartDate,
    performanceRating,
    performanceReportYear: snapshotYear,
    joiningDate,
    experienceYears,
    experienceMonths,
    experienceDays,
    experienceReferenceDate,
    currentJobStartDate,
    currentJobTenureYears,
    currentJobTenureMonths,
    currentJobTenureDays,
    currentJobTenureReferenceDate,
    originalQualificationSource,
    originalQualificationCertificate,
    originalQualificationDate,
    mappedRoutingUnitId,
    validationStatus: determineRowStatus(messages),
    validationMessages: messages
  }
}

export function applyDuplicatePersonnelValidation(rows: NormalizedStagingRow[]): void {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.personnelNumber) {
      counts.set(row.personnelNumber, (counts.get(row.personnelNumber) ?? 0) + 1)
    }
  }
  for (const row of rows) {
    if (!row.personnelNumber || (counts.get(row.personnelNumber) ?? 0) < 2) continue
    row.validationMessages.push({
      code: 'PERSONNEL_NUMBER_DUPLICATE',
      severity: 'BLOCKING',
      field: 'personnelNumber',
      message: `Personnel Number "${row.personnelNumber}" is duplicated within this import batch`
    })
    row.validationStatus = 'BLOCKED'
  }
}

export function rowsFromStoredRaw(
  rows: Array<{
    sourceRowNumber: number
    raw: Record<string, string | number | boolean | null>
    experienceReferenceDate?: string
    currentJobTenureReferenceDate?: string
  }>
): SourceWorkbookRow[] {
  return rows.map(row => ({
    sourceRowNumber: row.sourceRowNumber,
    raw: row.raw,
    values: new Map(Object.entries(row.raw)),
    ...(row.experienceReferenceDate !== undefined
      ? { experienceReferenceDate: row.experienceReferenceDate }
      : {}),
    ...(row.currentJobTenureReferenceDate !== undefined
      ? { currentJobTenureReferenceDate: row.currentJobTenureReferenceDate }
      : {})
  }))
}

export function buildEmployeeAnnualData(row: NormalizedStagingRow): Record<string, unknown> {
  return {
    sourceRowNumber: row.sourceRowNumber,
    sourceOrder: row.sourceOrder,
    personnelNumber: row.personnelNumber,
    employeeName: row.employeeName,
    employeeGroup: row.employeeGroup,
    employeeSubgroup: row.subgroup,
    sourceRoutingLabel: row.sourceRoutingUnit,
    resolvedRoutingUnitId: row.mappedRoutingUnitId,
    currentJobTitle: row.currentJobTitle,
    lastPromotionDate: row.lastPromotionDate,
    experienceStartDate: row.experienceStartDate,
    performanceRating: row.performanceRating,
    performanceReportYear: row.performanceReportYear,
    joiningDate: row.joiningDate,
    experienceYears: row.experienceYears,
    experienceMonths: row.experienceMonths,
    experienceDays: row.experienceDays,
    experienceReferenceDate: row.experienceReferenceDate,
    currentJobStartDate: row.currentJobStartDate,
    currentJobTenureYears: row.currentJobTenureYears,
    currentJobTenureMonths: row.currentJobTenureMonths,
    currentJobTenureDays: row.currentJobTenureDays,
    currentJobTenureReferenceDate: row.currentJobTenureReferenceDate,
    originalQualificationSource: row.originalQualificationSource,
    originalQualificationCertificate: row.originalQualificationCertificate,
    originalQualificationDate: row.originalQualificationDate
  }
}

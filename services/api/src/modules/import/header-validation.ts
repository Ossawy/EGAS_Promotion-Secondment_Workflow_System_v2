export const SEMANTIC_FIELD_LABELS = {
  sourceOrder: 'م',
  personnelNumber: 'رقم الموظف',
  employeeName: 'اسم الموظف',
  employeeGroup: 'مجموعة الموظفين',
  subgroup: 'المجموعة الفرعية',
  sourceRoutingUnit: 'النيابة / المساعد',
  currentJobTitle: 'الوظيفة',
  lastPromotionDate: 'تاريخ اقدمية أخر ترقية',
  experienceStartDate: 'تاريخ بداية الخبرة',
  performanceRating: 'تقرير كفاية',
  joiningDate: 'تاريخ الالتحاق',
  experienceYears: 'عدد سنوات الخبرة حتى 1/1',
  experienceMonths: 'عدد شهور الخبرة حتى 1/1',
  experienceDays: 'عدد ايام الخبرة حتى 1/1',
  currentJobTenureYears: 'عدد سنوات حتى 1/7',
  currentJobTenureMonths: 'عدد شهور حتى 1/7',
  currentJobTenureDays: 'عدد ايام حتى 1/7',
  qualificationSource1: 'المؤسسة التعليمية-المؤهل الاصلي',
  qualificationSource2: 'الشهادة-المؤهل الاصلي',
  qualificationDate: 'تاريخ المؤهل الاصلي',
  currentJobStartDate: 'بداية شغل الوظيفة'
} as const

export type ImportSemanticField = keyof typeof SEMANTIC_FIELD_LABELS

export const ALL_SEMANTIC_FIELDS = Object.keys(SEMANTIC_FIELD_LABELS) as readonly ImportSemanticField[]

export interface HeaderValidationResult {
  valid: boolean
  normalizedHeaders: string[]
  fieldToColumn: Record<ImportSemanticField, number>
  columnToField: Record<number, ImportSemanticField>
  missingFields: ImportSemanticField[]
  duplicateFields: ImportSemanticField[]
  unexpectedHeaders: string[]
  performanceYear: number | null
  experienceReferenceDate: string
  currentJobTenureReferenceDate: string
  errors: string[]
}

export function cleanHeaderString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeRoutingLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return cleanHeaderString(value)
    .replace(/[\\]/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
}

function normalizeArabicHeader(value: string): string {
  return cleanHeaderString(value)
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\\]/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*[-–—]\s*/g, '-')
    .toLowerCase()
}

function extractDateFromPattern(norm: string, baseMonthDay: string, requestedYear: number): string {
  // 1. Check for non-zero prefix year: e.g. "2027/..." or "2027 ..."
  const prefixMatch = /^(\d{4})[/ ]/.exec(norm)
  if (prefixMatch && prefixMatch[1] !== '0000') {
    const prefixYear = Number(prefixMatch[1])
    if (prefixYear >= 1900 && prefixYear <= 2200) {
      return `${prefixYear}-${baseMonthDay}`
    }
  }

  // 2. Check for suffix year after 1/1 or 1/7: e.g. "1/1/2026" or "1/7/2026"
  const marker = baseMonthDay === '01-01' ? '1[/\\\\]1' : '1[/\\\\]7'
  const suffixPattern = new RegExp(`${marker}[/\\\\](\\d{4})`)
  const suffixMatch = suffixPattern.exec(norm)
  if (suffixMatch && suffixMatch[1] !== '0000') {
    const suffixYear = Number(suffixMatch[1])
    if (suffixYear >= 1900 && suffixYear <= 2200) {
      return `${suffixYear}-${baseMonthDay}`
    }
  }

  // 3. Fallback to requested snapshot year
  return `${requestedYear}-${baseMonthDay}`
}

export function matchSemanticHeader(header: string, requestedYear: number): {
  field: ImportSemanticField
  performanceYear?: number | null
  referenceDate?: string
} | null {
  const norm = normalizeArabicHeader(header)
  if (!norm) return null

  // 1. Row index: م or مسلسل or م.
  if (/^(م|مسلسل|م\.)$/.test(norm)) return { field: 'sourceOrder' }

  // 2. Personnel Number: رقم الموظف
  if (/^رقم\s*الموظف$/.test(norm)) return { field: 'personnelNumber' }

  // 3. Employee Name: اسم الموظف
  if (/^اسم\s*الموظف$/.test(norm)) return { field: 'employeeName' }

  // 4. Employee Group: مجموعة الموظفين
  if (/^مجموعه\s*الموظفين$/.test(norm)) return { field: 'employeeGroup' }

  // 5. Subgroup: المجموعة الفرعية
  if (/^المجموعه\s*الفرعيه$/.test(norm)) return { field: 'subgroup' }

  // 6. Routing Label: النيابة / المساعد
  if (/^النيابه\/المساعد$/.test(norm) || /^النيابه\s+المساعد$/.test(norm)) {
    return { field: 'sourceRoutingUnit' }
  }

  // 7. Job Title: الوظيفة
  if (/^الوظيفه$/.test(norm)) return { field: 'currentJobTitle' }

  // 8. Last promotion date: تاريخ اقدمية أخر ترقية
  if (/^تاريخ\s*اقدميه\s*(اخر|أخر)\s*ترقيه$/.test(norm) || /^تاريخ\s*اقدميه\s*ترقيه$/.test(norm)) {
    return { field: 'lastPromotionDate' }
  }

  // 9. Experience start date: تاريخ بداية الخبرة
  if (/^تاريخ\s*بداية\s*الخبره$/.test(norm) || /^تاريخ\s*بدايه\s*الخبره$/.test(norm)) {
    return { field: 'experienceStartDate' }
  }

  // 10. Performance rating: Requires explicit تقرير كفاية <YEAR> with 4-digit year (or configured exact header override)
  const envConfiguredHeader = process.env.EGAS_IMPORT_PERFORMANCE_HEADER?.trim()
  if (envConfiguredHeader && cleanHeaderString(header) === envConfiguredHeader) {
    return { field: 'performanceRating', performanceYear: requestedYear }
  }
  const perfMatch = /^تقرير\s*كفايه\s*(\d{4})$/.exec(norm)
  if (perfMatch) {
    const yearNumber = Number(perfMatch[1])
    return { field: 'performanceRating', performanceYear: yearNumber }
  }

  // 11. Joining date: تاريخ الالتحاق
  if (/^تاريخ\s*الالتحاق$/.test(norm)) return { field: 'joiningDate' }

  // 12-14. Experience Duration triplet as of 1/1 (does not require physical "الخبرة" in month/day headers)
  if (/(?:سنوات|السنوات).*1\/1/.test(norm)) {
    return { field: 'experienceYears', referenceDate: extractDateFromPattern(norm, '01-01', requestedYear) }
  }
  if (/(?:شهور|الشهور).*1\/1/.test(norm)) {
    return { field: 'experienceMonths', referenceDate: extractDateFromPattern(norm, '01-01', requestedYear) }
  }
  if (/(?:ايام|الايام).*1\/1/.test(norm)) {
    return { field: 'experienceDays', referenceDate: extractDateFromPattern(norm, '01-01', requestedYear) }
  }

  // 15-17. Job Tenure Duration triplet as of 1/7
  if (/(?:سنوات|السنوات).*1\/7/.test(norm)) {
    return { field: 'currentJobTenureYears', referenceDate: extractDateFromPattern(norm, '07-01', requestedYear) }
  }
  if (/(?:شهور|الشهور).*1\/7/.test(norm)) {
    return { field: 'currentJobTenureMonths', referenceDate: extractDateFromPattern(norm, '07-01', requestedYear) }
  }
  if (/(?:ايام|الايام).*1\/7/.test(norm)) {
    return { field: 'currentJobTenureDays', referenceDate: extractDateFromPattern(norm, '07-01', requestedYear) }
  }

  // 18. Qualification Institution: المؤسسة التعليمية-المؤهل الاصلي
  if (/المؤسسه\s*التعليميه-المؤهل\s*الاصلي/.test(norm)) {
    return { field: 'qualificationSource1' }
  }

  // 19. Qualification Certificate: الشهادة-المؤهل الاصلي
  if (/الشهاده-المؤهل\s*الاصلي/.test(norm)) {
    return { field: 'qualificationSource2' }
  }

  // 20. Qualification Date: تاريخ المؤهل الاصلي
  if (/^تاريخ\s*المؤهل\s*الاصلي$/.test(norm)) {
    return { field: 'qualificationDate' }
  }

  // 21. Job Start Date: بداية شغل الوظيفة
  if (/^بدايه\s*شغل\s*الوظيفه$/.test(norm) || /^بداية\s*شغل\s*الوظيفه$/.test(norm)) {
    return { field: 'currentJobStartDate' }
  }

  return null
}

export function validateHeaders(
  headers: readonly unknown[],
  requestedYear: number
): HeaderValidationResult {
  const normalizedHeaders = headers.map(cleanHeaderString)
  const fieldToColumn = {} as Record<ImportSemanticField, number>
  const columnToField = {} as Record<number, ImportSemanticField>
  const fieldCounts = new Map<ImportSemanticField, number[]>()
  const detectedRefDates = new Map<ImportSemanticField, string>()
  const unexpectedHeaders: string[] = []
  const errors: string[] = []
  let performanceYear: number | null = null

  headers.forEach((raw, index) => {
    const headerStr = cleanHeaderString(raw)
    if (!headerStr) return
    const matched = matchSemanticHeader(headerStr, requestedYear)
    if (matched) {
      const { field, performanceYear: matchedYear, referenceDate } = matched
      const existing = fieldCounts.get(field) ?? []
      existing.push(index + 1)
      fieldCounts.set(field, existing)
      columnToField[index + 1] = field
      fieldToColumn[field] = index + 1

      if (referenceDate) {
        detectedRefDates.set(field, referenceDate)
      }

      if (field === 'performanceRating') {
        performanceYear = matchedYear ?? null
        if (matchedYear !== undefined && matchedYear !== null && matchedYear !== requestedYear) {
          errors.push(
            `Performance report header year (${matchedYear}) does not match requested snapshot year (${requestedYear})`
          )
        }
      }
    } else {
      unexpectedHeaders.push(headerStr)
    }
  })

  const missingFields: ImportSemanticField[] = []
  const duplicateFields: ImportSemanticField[] = []

  for (const field of ALL_SEMANTIC_FIELDS) {
    const cols = fieldCounts.get(field)
    if (!cols || cols.length === 0) {
      missingFields.push(field)
      if (field === 'performanceRating') {
        errors.push(`Missing required performance report column: تقرير كفاية ${requestedYear}`)
      } else {
        errors.push(`Missing required semantic column: ${SEMANTIC_FIELD_LABELS[field]} (${field})`)
      }
    } else if (cols.length > 1) {
      duplicateFields.push(field)
      errors.push(`Duplicate columns mapped to ${SEMANTIC_FIELD_LABELS[field]} (${field}): columns ${cols.join(', ')}`)
    }
  }

  // Triplet reference date consistency checks
  const expYearsDate = detectedRefDates.get('experienceYears')
  const expMonthsDate = detectedRefDates.get('experienceMonths')
  const expDaysDate = detectedRefDates.get('experienceDays')
  let experienceReferenceDate = `${requestedYear}-01-01`

  if (expYearsDate || expMonthsDate || expDaysDate) {
    const dates = [expYearsDate, expMonthsDate, expDaysDate].filter(Boolean) as string[]
    const distinctDates = [...new Set(dates)]
    if (distinctDates.length > 1) {
      errors.push(
        `Inconsistent experience duration reference dates across triplet headers: ${distinctDates.join(', ')}`
      )
    }
    experienceReferenceDate = distinctDates[0] ?? `${requestedYear}-01-01`
  }

  const tenureYearsDate = detectedRefDates.get('currentJobTenureYears')
  const tenureMonthsDate = detectedRefDates.get('currentJobTenureMonths')
  const tenureDaysDate = detectedRefDates.get('currentJobTenureDays')
  let currentJobTenureReferenceDate = `${requestedYear}-07-01`

  if (tenureYearsDate || tenureMonthsDate || tenureDaysDate) {
    const dates = [tenureYearsDate, tenureMonthsDate, tenureDaysDate].filter(Boolean) as string[]
    const distinctDates = [...new Set(dates)]
    if (distinctDates.length > 1) {
      errors.push(
        `Inconsistent job tenure duration reference dates across triplet headers: ${distinctDates.join(', ')}`
      )
    }
    currentJobTenureReferenceDate = distinctDates[0] ?? `${requestedYear}-07-01`
  }

  return {
    valid: errors.length === 0,
    normalizedHeaders: normalizedHeaders.filter(Boolean),
    fieldToColumn,
    columnToField,
    missingFields,
    duplicateFields,
    unexpectedHeaders,
    performanceYear,
    experienceReferenceDate,
    currentJobTenureReferenceDate,
    errors
  }
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  cleanHeaderString,
  normalizeRoutingLabel,
  validateHeaders
} from '../src/modules/import/header-validation.js'
import {
  normalizeDateValue,
  parseDurationInteger,
  normalizeStagingRow,
  type RoutingIndex,
  type NormalizedStagingRow
} from '../src/modules/import/normalization.js'
import { inspectAnnualWorkbook } from '../src/modules/import/workbook-inspector.js'

const canonicalHeaders2026 = [
  'م',
  'رقم الموظف',
  'اسم الموظف',
  'مجموعة الموظفين',
  'المجموعة الفرعية',
  'النيابة / المساعد',
  'الوظيفة',
  'تاريخ اقدمية أخر ترقية',
  'تاريخ بداية الخبرة',
  'تقرير كفاية 2026',
  'تاريخ الالتحاق',
  'عدد سنوات الخبرة حتى 1/1/2026',
  'عدد شهور الخبرة حتى 1/1/2026',
  'عدد ايام الخبرة حتى 1/1/2026',
  'عدد سنوات حتى 1/7/2026',
  'عدد شهور حتى 1/7/2026',
  'عدد ايام حتى 1/7/2026',
  'المؤسسة التعليمية-المؤهل الاصلي',
  'الشهادة-المؤهل الاصلي',
  'تاريخ المؤهل الاصلي',
  'بداية شغل الوظيفة'
]

const realEgasHeaders2026 = [
  'م',
  'رقم الموظف',
  'اسم الموظف',
  'مجموعة الموظفين',
  'المجموعة الفرعية',
  'النيابة / المساعد',
  'الوظيفة',
  'تاريخ اقدمية أخر ترقية',
  'تاريخ بداية الخبرة',
  'تقرير كفاية 2026',
  'تاريخ الالتحاق',
  '0000 /عدد سنوات الخبرة حتى 1/1',
  '0000 \\عدد الشهور حتى 1\\1',
  '0000 \\عدد الايام حتى 1\\1',
  '0000 \\عدد السنوات حتى 1\\7',
  '0000 \\عددالشهور حتى 1\\7',
  '0000 \\عدداالايام حتى 1\\7',
  'المؤسسة التعليمية-المؤهل الاصلي',
  'الشهادة-المؤهل الاصلي',
  'تاريخ المؤهل الاصلي',
  'بداية شغل الوظيفة'
]

const routingSample: RoutingIndex = {
  targetsByNormalizedLabel: new Map([
    ['النيابة/المساعد', [{ id: 'unit-1', nameAr: 'النيابة / المساعد' }]],
    ['شئون مالية', [{ id: 'unit-2', nameAr: 'شئون مالية' }]],
    ['شئون ملتبسة', [
      { id: 'unit-3', nameAr: 'شئون ملتبسة أ' },
      { id: 'unit-4', nameAr: 'شئون ملتبسة ب' }
    ]]
  ])
}

describe('Phase 2 Annual Employee Data — Current v5 Pipeline Tests', () => {
  describe('A & E: Header mapping and reference date detection', () => {
    it('successfully validates and maps all approved A:U columns for the snapshot year', () => {
      const result = validateHeaders(canonicalHeaders2026, 2026)
      expect(result.valid).toBe(true)
      expect(result.missingFields).toHaveLength(0)
      expect(result.duplicateFields).toHaveLength(0)
      expect(result.performanceYear).toBe(2026)
      expect(result.experienceReferenceDate).toBe('2026-01-01')
      expect(result.currentJobTenureReferenceDate).toBe('2026-07-01')
    })

    it('successfully validates and maps the exact real EGAS workbook duration headers with 0000 placeholder prefix', () => {
      const result = validateHeaders(realEgasHeaders2026, 2026)
      expect(result.valid).toBe(true)
      expect(result.missingFields).toHaveLength(0)
      expect(result.duplicateFields).toHaveLength(0)
      expect(result.fieldToColumn.experienceYears).toBe(12)
      expect(result.fieldToColumn.experienceMonths).toBe(13)
      expect(result.fieldToColumn.experienceDays).toBe(14)
      expect(result.fieldToColumn.currentJobTenureYears).toBe(15)
      expect(result.fieldToColumn.currentJobTenureMonths).toBe(16)
      expect(result.fieldToColumn.currentJobTenureDays).toBe(17)
      expect(result.experienceReferenceDate).toBe('2026-01-01')
      expect(result.currentJobTenureReferenceDate).toBe('2026-07-01')
    })

    it('preserves an explicit non-zero prefix year (e.g. 2027) as reference-date metadata', () => {
      const headers = [
        ...realEgasHeaders2026.slice(0, 11),
        '2027 /عدد سنوات الخبرة حتى 1/1',
        '2027 \\عدد الشهور حتى 1\\1',
        '2027 \\عدد الايام حتى 1\\1',
        ...realEgasHeaders2026.slice(14)
      ]
      const result = validateHeaders(headers, 2026)
      expect(result.valid).toBe(true)
      expect(result.experienceReferenceDate).toBe('2027-01-01')
      expect(result.currentJobTenureReferenceDate).toBe('2026-07-01')
    })

    it('fails closed when تقرير كفاية year does not match requested snapshot year', () => {
      const headers = canonicalHeaders2026.map(h => (h === 'تقرير كفاية 2026' ? 'تقرير كفاية 2025' : h))
      const result = validateHeaders(headers, 2026)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('does not match requested snapshot year'))).toBe(true)
    })

    it('fails closed when a required semantic field is duplicated', () => {
      const headers = [...canonicalHeaders2026, 'رقم الموظف']
      const result = validateHeaders(headers, 2026)
      expect(result.valid).toBe(false)
      expect(result.duplicateFields).toContain('personnelNumber')
    })

    it('fails closed when triplet duration headers contain inconsistent reference years', () => {
      const headers = canonicalHeaders2026.map(h => {
        if (h === 'عدد شهور الخبرة حتى 1/1/2026') return 'عدد شهور الخبرة حتى 1/1/2025'
        return h
      })
      const result = validateHeaders(headers, 2026)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('Inconsistent experience duration reference dates'))).toBe(true)
    })
  })

  describe('B: 10-Sentinel scoping and strict integer preservation', () => {
    it('normalizes performance rating 10 to null with warning, but preserves numeric 10 in durations and data', () => {
      const rowSource = {
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['sourceOrder', '10'],
          ['personnelNumber', '10'],
          ['employeeName', '10'],
          ['employeeGroup', '10'],
          ['subgroup', '10'],
          ['sourceRoutingUnit', 'شئون مالية'],
          ['currentJobTitle', '10'],
          ['performanceRating', '10'],
          ['experienceYears', 10],
          ['experienceMonths', '10'],
          ['experienceDays', 10],
          ['currentJobTenureYears', '10'],
          ['currentJobTenureMonths', 10],
          ['currentJobTenureDays', '10'],
          ['qualificationSource1', '10'],
          ['qualificationSource2', '10']
        ])
      }

      const normalized = normalizeStagingRow(rowSource, 2026, routingSample)
      expect(normalized.personnelNumber).toBe('10')
      expect(normalized.employeeName).toBe('10')
      expect(normalized.employeeGroup).toBe('10')
      expect(normalized.currentJobTitle).toBe('10')
      expect(normalized.originalQualificationSource).toBe('10')
      expect(normalized.performanceRating).toBeNull()
      expect(normalized.validationMessages.some(m => m.code === 'PERFORMANCE_MISSING')).toBe(true)
      expect(normalized.experienceYears).toBe(10)
      expect(normalized.experienceMonths).toBe(10)
      expect(normalized.experienceDays).toBe(10)
      expect(normalized.currentJobTenureYears).toBe(10)
      expect(normalized.currentJobTenureMonths).toBe(10)
      expect(normalized.currentJobTenureDays).toBe(10)
    })

    it('rejects malformed integer durations like "12abc" and floats like 2.9 with BLOCKING messages', () => {
      expect(parseDurationInteger('12abc')).toEqual({ kind: 'INVALID' })
      expect(parseDurationInteger(2.9)).toEqual({ kind: 'INVALID' })
      expect(parseDurationInteger('2.9')).toEqual({ kind: 'INVALID' })
      expect(parseDurationInteger(-5)).toEqual({ kind: 'INVALID' })
      expect(parseDurationInteger('5')).toEqual({ kind: 'VALID', value: 5 })
      expect(parseDurationInteger(0)).toEqual({ kind: 'VALID', value: 0 })

      const rowSource = {
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', 'شئون مالية'],
          ['experienceYears', '12abc'],
          ['currentJobTenureYears', 2.9]
        ])
      }
      const normalized = normalizeStagingRow(rowSource, 2026, routingSample)
      expect(normalized.validationMessages.some(m => m.code === 'EXPERIENCE_YEARS_INVALID')).toBe(true)
      expect(normalized.validationMessages.some(m => m.code === 'TENURE_YEARS_INVALID')).toBe(true)
    })

    it('accepts ممتاز, جيد جدا, and جيد as VALID with no warning messages, and blocks unknown performance values', () => {
      for (const rating of ['ممتاز', 'جيد جدا', 'جيد']) {
        const rowSource = {
          sourceRowNumber: 2,
          raw: {},
          values: new Map<string, any>([
            ['personnelNumber', '1001'],
            ['employeeName', 'موظف اختباري'],
            ['sourceRoutingUnit', 'شئون مالية'],
            ['performanceRating', rating]
          ])
        }
        const normalized = normalizeStagingRow(rowSource, 2026, routingSample)
        expect(normalized.performanceRating).toBe(rating)
        expect(normalized.validationStatus).toBe('VALID')
        expect(normalized.validationMessages).toHaveLength(0)
      }

      const unknownRowSource = {
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', 'شئون مالية'],
          ['performanceRating', 'مقبول']
        ])
      }
      const unknownNormalized = normalizeStagingRow(unknownRowSource, 2026, routingSample)
      expect(unknownNormalized.validationStatus).toBe('BLOCKED')
      expect(unknownNormalized.validationMessages.some(m => m.code === 'PERFORMANCE_UNKNOWN')).toBe(true)
    })
  })

  describe('C: Date normalization and malformed date handling', () => {
    it('normalizes valid dates and blocks malformed non-empty dates', () => {
      expect(normalizeDateValue('2026-01-15')).toEqual({ kind: 'VALID', value: '2026-01-15' })
      expect(normalizeDateValue('15/01/2026')).toEqual({ kind: 'VALID', value: '2026-01-15' })
      expect(normalizeDateValue(new Date('2026-01-15T00:00:00.000Z'))).toEqual({ kind: 'VALID', value: '2026-01-15' })
      expect(normalizeDateValue('')).toEqual({ kind: 'EMPTY', value: null })
      expect(normalizeDateValue('invalid-date')).toEqual({ kind: 'INVALID' })
      expect(normalizeDateValue('10')).toEqual({ kind: 'INVALID' })

      const rowSource = {
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', 'شئون مالية'],
          ['lastPromotionDate', 'not-a-date']
        ])
      }
      const normalized = normalizeStagingRow(rowSource, 2026, routingSample)
      expect(normalized.validationStatus).toBe('BLOCKED')
      expect(normalized.validationMessages.some(m => m.code === 'LAST_PROMOTION_DATE_INVALID' && m.severity === 'BLOCKING')).toBe(true)
    })
  })

  describe('D: Deterministic routing resolution', () => {
    it('resolves distinct routing targets and blocks unmapped or ambiguous targets', () => {
      const resolvedRow = normalizeStagingRow({
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', '  شئون   مالية  ']
        ])
      }, 2026, routingSample)
      expect(resolvedRow.mappedRoutingUnitId).toBe('unit-2')

      const unmappedRow = normalizeStagingRow({
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', 'شئون غير معروفة']
        ])
      }, 2026, routingSample)
      expect(unmappedRow.validationStatus).toBe('BLOCKED')
      expect(unmappedRow.validationMessages.some(m => m.code === 'ROUTING_UNMAPPED')).toBe(true)

      const ambiguousRow = normalizeStagingRow({
        sourceRowNumber: 2,
        raw: {},
        values: new Map<string, any>([
          ['personnelNumber', '1001'],
          ['employeeName', 'موظف اختباري'],
          ['sourceRoutingUnit', 'شئون ملتبسة']
        ])
      }, 2026, routingSample)
      expect(ambiguousRow.validationStatus).toBe('BLOCKED')
      expect(ambiguousRow.validationMessages.some(m => m.code === 'ROUTING_AMBIGUOUS')).toBe(true)
    })
  })

  describe('G: Synthetic XLSX workbook inspection & empty-row skipping', () => {
    it('inspects synthetic workbook with real EGAS duration headers, extracts headers, skips empty rows, and preserves reference dates', async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), 'egas-v5-test-'))
      const filePath = path.join(tempDir, 'synthetic_test.xlsx')

      try {
        const workbook = new ExcelJS.Workbook()
        const mainSheet = workbook.addWorksheet('البيانات الاساسية')
        mainSheet.addRow(realEgasHeaders2026)

        // Row 1: Valid data
        mainSheet.addRow([
          1,
          '001234',
          'أحمد محمود',
          'دائم',
          'فني',
          'النيابة / المساعد',
          'مهندس أول',
          '2020-01-01',
          '2015-01-01',
          'ممتاز',
          '2015-05-01',
          11,
          0,
          0,
          6,
          6,
          0,
          'جامعة القاهرة',
          'بكالوريوس هندسة',
          '2014-06-01',
          '2020-01-01'
        ])

        // Row 2: Structurally empty row (all blanks)
        mainSheet.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''])

        // Add reference sheet نيابة مساعد
        const refSheet = workbook.addWorksheet('نيابة مساعد')
        refSheet.addRow(['النيابة / المساعد'])
        refSheet.addRow(['شئون مالية'])
        refSheet.addRow(['شئون مالية']) // duplicate to verify deduplication

        await workbook.xlsx.writeFile(filePath)

        const inspection = await inspectAnnualWorkbook(filePath, 2026)
        expect(inspection.rowCount).toBe(1)
        expect(inspection.rows).toHaveLength(1)
        expect(inspection.rows[0]?.raw.personnelNumber).toBe('001234')
        expect(inspection.experienceReferenceDate).toBe('2026-01-01')
        expect(inspection.currentJobTenureReferenceDate).toBe('2026-07-01')
        expect(inspection.workbookRoutingLabels).toContain('شئون مالية')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('ignores formatted/empty rows far below data (e.g. row 30000) without rejecting the workbook on dimensions', async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), 'egas-v5-test-'))
      const filePath = path.join(tempDir, 'synthetic_formatted_empty.xlsx')

      try {
        const workbook = new ExcelJS.Workbook()
        const mainSheet = workbook.addWorksheet('البيانات الاساسية')
        mainSheet.addRow(realEgasHeaders2026)

        // Add 2 valid employee rows
        mainSheet.addRow([
          1,
          '001234',
          'أحمد محمود',
          'دائم',
          'فني',
          'النيابة / المساعد',
          'مهندس أول',
          '2020-01-01',
          '2015-01-01',
          'ممتاز',
          '2015-05-01',
          11,
          0,
          0,
          6,
          6,
          0,
          'جامعة القاهرة',
          'بكالوريوس هندسة',
          '2014-06-01',
          '2020-01-01'
        ])
        mainSheet.addRow([
          2,
          '001235',
          'محمود علي',
          'دائم',
          'إداري',
          'النيابة / المساعد',
          'أخصائي',
          '2021-01-01',
          '2016-01-01',
          'جيد جدا',
          '2016-05-01',
          10,
          0,
          0,
          5,
          6,
          0,
          'جامعة عين شمس',
          'بكالوريوس تجارة',
          '2015-06-01',
          '2021-01-01'
        ])

        // Apply formatting/styling to an otherwise completely empty cell far below data (row 30000)
        const emptyCell = mainSheet.getCell('A30000')
        emptyCell.style = {
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
          border: { top: { style: 'thin' } }
        }

        await workbook.xlsx.writeFile(filePath)

        const inspection = await inspectAnnualWorkbook(filePath, 2026)
        expect(inspection.rowCount).toBe(2)
        expect(inspection.rows).toHaveLength(2)
        expect(inspection.rows.map(r => r.raw.personnelNumber)).toEqual(['001234', '001235'])
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})

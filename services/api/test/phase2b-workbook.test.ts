import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { inspectAnnualWorkbook, WORKBOOK_LIMITS, type SourceWorkbookRow } from '../src/modules/import/workbook-inspector.js'
import { requiredHeadersForYear } from '../src/modules/import/header-validation.js'
import {
  applyDuplicatePersonnelValidation, normalizeQualificationDate, normalizeStagingRow, type RoutingIndex
} from '../src/modules/import/normalization.js'
import {
  cleanupSyntheticWorkbooks, malformedWorkbook, syntheticRow, syntheticWorkbook
} from './helpers/workbook.js'

afterEach(cleanupSyntheticWorkbooks)

const routing: RoutingIndex = {
  unitsByName: new Map([['UNIT_NAME', { id: 'unit-id', nameAr: 'UNIT_NAME' }]]),
  aliasesByLabel: new Map([['SOURCE_ALIAS', { id: 'unit-id', nameAr: 'UNIT_NAME' }]])
}

function source(overrides: Record<string, string | number | Date | null> = {}): SourceWorkbookRow {
  const values = syntheticRow(overrides)
  return { sourceRowNumber: 2, raw: values as Record<string, string | number | boolean | null>, values: new Map(Object.entries(values)) }
}

describe('Phase 2B secure workbook inspection', () => {
  it('1. accepts a valid approved workbook', async () => {
    const result = await inspectAnnualWorkbook(await syntheticWorkbook(), 2026)
    expect(result).toMatchObject({ year: 2026, rowCount: 1, headerRowNumber: 1 })
  })

  it('2. accepts reordered columns because matching is by header name', async () => {
    const headers = ['تاريخ المؤهل الاصلي', ...requiredHeadersForYear(2026).filter(value => value !== 'تاريخ المؤهل الاصلي').reverse()]
    expect((await inspectAnnualWorkbook(await syntheticWorkbook({ headers }), 2026)).rowCount).toBe(1)
  })

  it('3. rejects a missing required header', async () => {
    const headers = requiredHeadersForYear(2026).filter(value => value !== 'اسم الموظف')
    await expect(inspectAnnualWorkbook(await syntheticWorkbook({ headers }), 2026)).rejects.toMatchObject({ code: 'WORKBOOK_HEADERS_INVALID' })
  })

  it('4. rejects a duplicate required header', async () => {
    const headers = [...requiredHeadersForYear(2026), 'رقم الموظف']
    await expect(inspectAnnualWorkbook(await syntheticWorkbook({ headers }), 2026)).rejects.toMatchObject({ code: 'WORKBOOK_HEADERS_INVALID' })
  })

  it('5. rejects an unrelated workbook', async () => {
    await expect(inspectAnnualWorkbook(await syntheticWorkbook({ headers: ['A','B','C'] }), 2026)).rejects.toMatchObject({ code: 'WORKBOOK_REJECTED' })
  })

  it('6. rejects macro-enabled filename extensions', async () => {
    await expect(inspectAnnualWorkbook(await syntheticWorkbook({ extension: 'xlsm' }), 2026)).rejects.toMatchObject({ code: 'WORKBOOK_REJECTED' })
  })

  it('7. rejects malformed XLSX bytes', async () => {
    await expect(inspectAnnualWorkbook(await malformedWorkbook(), 2026)).rejects.toMatchObject({ code: 'WORKBOOK_REJECTED' })
  })

  it('8. rejects oversized workbook files before decompression', async () => {
    const file = await malformedWorkbook()
    await writeFile(file, Buffer.alloc(WORKBOOK_LIMITS.fileBytes + 1))
    await expect(inspectAnnualWorkbook(file, 2026)).rejects.toThrow(/size/)
  })

  it('9. preserves Arabic cell text and leading-zero Personnel Numbers', async () => {
    const result = await inspectAnnualWorkbook(await syntheticWorkbook(), 2026)
    expect(result.rows[0]!.values.get('رقم الموظف')).toBe('000123')
    expect(result.rows[0]!.values.get('اسم الموظف')).toBe('موظف اختباري')
  })

  it('10. rejects formulas rather than evaluating or importing them', async () => {
    const file = await syntheticWorkbook({ formulaHeader: 'الوظيفة' })
    await expect(inspectAnnualWorkbook(file, 2026)).rejects.toThrow(/Formulas/)
  })

  it('11. rejects excessive worksheet columns', async () => {
    const file = await syntheticWorkbook({ extraColumns: WORKBOOK_LIMITS.columns })
    await expect(inspectAnnualWorkbook(file, 2026)).rejects.toThrow(/columns/)
  })

  it('12. rejects oversized cell strings', async () => {
    const file = await syntheticWorkbook({ rows: [syntheticRow({ الوظيفة: 'x'.repeat(WORKBOOK_LIMITS.cellCharacters + 1) })] })
    await expect(inspectAnnualWorkbook(file, 2026)).rejects.toThrow(/cell exceeds/)
  })

  it('13. rejects ambiguous multiple matching worksheets', async () => {
    await expect(inspectAnnualWorkbook(await syntheticWorkbook({ secondMatchingSheet: true }), 2026)).rejects.toThrow(/More than one/)
  })
})

describe('Phase 2B normalization and deterministic routing', () => {
  it('14. normalizes blank performance to NULL with a missing warning', () => {
    const row = normalizeStagingRow(source({ 'تقرير كفاية 2026': '' }), 2026, routing)
    expect(row).toMatchObject({ performanceRating: null, validationStatus: 'WARNING' })
  })

  it('15. normalizes whitespace performance to NULL', () => {
    expect(normalizeStagingRow(source({ 'تقرير كفاية 2026': '   ' }), 2026, routing).performanceRating).toBeNull()
  })

  it('16. normalizes literal 10 performance to NULL', () => {
    expect(normalizeStagingRow(source({ 'تقرير كفاية 2026': ' 10 ' }), 2026, routing).performanceRating).toBeNull()
  })

  it('17. blocks blank routing', () => {
    expect(normalizeStagingRow(source({ 'النيابة /المساعد': '' }), 2026, routing)).toMatchObject({ sourceRoutingUnit: null, validationStatus: 'BLOCKED' })
  })

  it('18. treats literal 10 routing as NULL and blocks it', () => {
    expect(normalizeStagingRow(source({ 'النيابة /المساعد': '10' }), 2026, routing)).toMatchObject({ sourceRoutingUnit: null, validationStatus: 'BLOCKED' })
  })

  it('19. blocks an unknown routing label', () => {
    const row = normalizeStagingRow(source({ 'النيابة /المساعد': 'UNKNOWN' }), 2026, routing)
    expect(row.validationMessages.map(value => value.code)).toContain('ROUTING_UNMAPPED')
  })

  it('20. resolves an exact active RoutingUnit name', () => {
    expect(normalizeStagingRow(source(), 2026, routing).mappedRoutingUnitId).toBe('unit-id')
  })

  it('21. resolves an explicit active source alias', () => {
    expect(normalizeStagingRow(source({ 'النيابة /المساعد': 'SOURCE_ALIAS' }), 2026, routing).mappedRoutingUnitId).toBe('unit-id')
  })

  it('22. performs no fuzzy, substring, or spelling routing', () => {
    expect(normalizeStagingRow(source({ 'النيابة /المساعد': 'UNIT_NAM' }), 2026, routing).mappedRoutingUnitId).toBeNull()
  })

  it('23. marks every duplicate Personnel Number row BLOCKED', () => {
    const rows = [normalizeStagingRow(source(), 2026, routing), normalizeStagingRow({ ...source(), sourceRowNumber: 3 }, 2026, routing)]
    applyDuplicatePersonnelValidation(rows)
    expect(rows.every(row => row.validationStatus === 'BLOCKED')).toBe(true)
  })

  it('24. reports an invalid qualification date', () => {
    const row = normalizeStagingRow(source({ 'تاريخ المؤهل الاصلي': '31/02/2020' }), 2026, routing)
    expect(row.validationMessages.map(value => value.code)).toContain('QUALIFICATION_DATE_INVALID')
  })

  it('25. accepts a blank qualification date as NULL', () => {
    expect(normalizeStagingRow(source({ 'تاريخ المؤهل الاصلي': '' }), 2026, routing).qualificationDate).toBeNull()
  })

  it('26. accepts real Excel/JavaScript date values', () => {
    expect(normalizeQualificationDate(new Date('2020-01-15T00:00:00Z'))).toBe('2020-01-15')
    expect(normalizeQualificationDate(43_845)).toBe('2020-01-15')
  })

  it('27. reports an unknown performance value as blocking', () => {
    const row = normalizeStagingRow(source({ 'تقرير كفاية 2026': 'غير معروف' }), 2026, routing)
    expect(row).toMatchObject({ performanceRating: null, validationStatus: 'BLOCKED' })
  })

  it('28. preserves subgroup without a second eligibility filter', () => {
    const row = normalizeStagingRow(source({ 'المجموعة الفرعية': 'أي مجموعة' }), 2026, routing)
    expect(row).toMatchObject({ subgroup: 'أي مجموعة', validationStatus: 'VALID' })
  })

  it('29. does not fabricate administration or organizational-dependency fields', () => {
    const row = normalizeStagingRow(source(), 2026, routing) as unknown as Record<string, unknown>
    expect(row).not.toHaveProperty('الإدارة')
    expect(row).not.toHaveProperty('التبعية التنظيمية')
  })

  it('30. treats جيد as a warning rather than a rejection', () => {
    const row = normalizeStagingRow(source({ 'تقرير كفاية 2026': 'جيد' }), 2026, routing)
    expect(row).toMatchObject({ performanceRating: 'جيد', validationStatus: 'WARNING' })
  })
})

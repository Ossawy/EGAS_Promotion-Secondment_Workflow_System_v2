import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { requiredHeadersForYear } from '../../src/modules/import/header-validation.js'

const temporaryDirectories: string[] = []

export type SyntheticRow = Record<string, string | number | Date | null>

export function syntheticRow(overrides: SyntheticRow = {}): SyntheticRow {
  return {
    'رقم الموظف': '000123',
    'اسم الموظف': 'موظف اختباري',
    'المجموعة الفرعية': 'مجموعة اختبارية',
    'النيابة /المساعد': 'UNIT_NAME',
    'الوظيفة': 'وظيفة اختبارية',
    'تقرير كفاية 2026': 'ممتاز',
    'المؤسسة التعليمية-المؤهل الاصلي': 'جهة تعليمية اختبارية',
    'الشهادة-المؤهل الاصلي': 'مؤهل اختباري',
    'تاريخ المؤهل الاصلي': '2020-01-15',
    ...overrides
  }
}

export async function syntheticWorkbook(options: {
  headers?: string[]
  rows?: SyntheticRow[]
  extension?: string
  formulaHeader?: string
  extraColumns?: number
  secondMatchingSheet?: boolean
} = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'egas-phase2b-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, `annual.${options.extension ?? 'xlsx'}`)
  const workbook = new ExcelJS.Workbook()
  const headers = options.headers ?? ['م', ...requiredHeadersForYear(2026)]
  const sheet = workbook.addWorksheet('Annual')
  sheet.addRow(headers)
  for (const [index, source] of (options.rows ?? [syntheticRow()]).entries()) {
    const values = headers.map(header => header === 'م' ? index + 1 : source[header] ?? null)
    const row = sheet.addRow(values)
    if (options.formulaHeader) {
      const column = headers.indexOf(options.formulaHeader) + 1
      row.getCell(column).value = { formula: '1+1', result: 2 }
    }
  }
  for (let index = 0; index < (options.extraColumns ?? 0); index += 1) {
    sheet.getCell(1, headers.length + index + 1).value = `EXTRA_${index}`
  }
  if (options.secondMatchingSheet) {
    const second = workbook.addWorksheet('Annual Two')
    second.addRow(headers)
    second.addRow(headers.map(header => header === 'م' ? 1 : syntheticRow()[header] ?? null))
  }
  await workbook.xlsx.writeFile(file)
  return file
}

export async function malformedWorkbook(bytes = Buffer.from('not-an-xlsx')): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'egas-phase2b-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, 'malformed.xlsx')
  await writeFile(file, bytes)
  return file
}

export async function cleanupSyntheticWorkbooks(): Promise<void> {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  requiredHeadersForYear,
  validateHeaders,
  type HeaderValidationResult
} from './header-validation.js'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ROWS = 25_000

export interface WorkbookInspection {
  file: string
  year: number
  sheetName: string
  rowCount: number
  headers: HeaderValidationResult
}

function hasXlsxZipSignature(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

export async function inspectAnnualWorkbook(
  file: string,
  year: number
): Promise<WorkbookInspection> {
  const resolved = path.resolve(file)
  if (path.extname(resolved).toLowerCase() !== '.xlsx') {
    throw new Error('Only the approved .xlsx workbook format is accepted; .xlsm and .xls are rejected')
  }

  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) throw new Error('Import path must point to a regular file')
  if (fileStat.size <= 0 || fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`Workbook size must be between 1 byte and ${MAX_FILE_BYTES} bytes`)
  }

  const bytes = await readFile(resolved)
  if (!hasXlsxZipSignature(bytes)) throw new Error('File does not have an XLSX/ZIP container signature')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]
  )
  const requiredHeaders = requiredHeadersForYear(year)
  const candidates: WorkbookInspection[] = []

  for (const sheet of workbook.worksheets) {
    if (sheet.actualRowCount > MAX_ROWS + 20) {
      throw new Error(`Worksheet ${sheet.name} exceeds ${MAX_ROWS} data rows`)
    }

    // Search only the small header preamble; values still match by exact header name.
    const headerSearchLimit = Math.min(20, sheet.actualRowCount)
    for (let rowNumber = 1; rowNumber <= headerSearchLimit; rowNumber += 1) {
      const values: unknown[] = []
      sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        values[columnNumber - 1] = cell.text
      })
      const headers = validateHeaders(values, requiredHeaders)
      if (!headers.valid) continue

      candidates.push({
        file: resolved,
        year,
        sheetName: sheet.name,
        rowCount: Math.max(0, sheet.actualRowCount - rowNumber),
        headers
      })
      break
    }
  }

  if (candidates.length === 0) {
    throw new Error('No worksheet has the complete, exact, non-duplicated approved header set')
  }
  if (candidates.length > 1) {
    throw new Error('More than one worksheet matches the approved header set; operator selection is required')
  }

  return candidates[0]!
}

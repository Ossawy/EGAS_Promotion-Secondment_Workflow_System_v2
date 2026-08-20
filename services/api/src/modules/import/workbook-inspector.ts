import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { AppError } from '../../shared/errors.ts'
import {
  cleanHeaderString,
  normalizeRoutingLabel,
  validateHeaders,
  type HeaderValidationResult,
  type ImportSemanticField
} from './header-validation.ts'

export const WORKBOOK_LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  largestEntryBytes: 50 * 1024 * 1024,
  zipEntries: 2_000,
  worksheets: 10,
  rows: 25_000,
  columns: 100,
  cellCharacters: 2_000,
  headerSearchRows: 20
})

export type WorkbookCell = string | number | boolean | Date | null
export type RawJsonValue = string | number | boolean | null

export interface SourceWorkbookRow {
  sourceRowNumber: number
  raw: Record<string, RawJsonValue>
  values: ReadonlyMap<string, WorkbookCell>
  experienceReferenceDate?: string
  currentJobTenureReferenceDate?: string
}

export interface WorkbookInspection {
  file: string
  basename: string
  sourceSha256: string
  year: number
  sheetName: string
  headerRowNumber: number
  rowCount: number
  headers: HeaderValidationResult
  rows: SourceWorkbookRow[]
  workbookRoutingLabels: string[]
  experienceReferenceDate: string
  currentJobTenureReferenceDate: string
}

type ZipEntry = { name: string, expanded: number }
type ZipDirectory = { end: number, entryCount: number, directoryBytes: number, directoryOffset: number }
type ParsedZipEntry = { entry: ZipEntry, nextOffset: number }

function workbookError(message: string, code = 'WORKBOOK_REJECTED'): AppError {
  return new AppError(400, message, code)
}

function locateEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = bytes.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === bytes.length) return offset
  }
  throw workbookError('Malformed XLSX ZIP directory')
}

function readZipDirectory(bytes: Buffer): ZipDirectory {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0x4b50) {
    throw workbookError('File does not have an XLSX ZIP container signature')
  }
  const end = locateEndOfCentralDirectory(bytes)
  const disk = bytes.readUInt16LE(end + 4)
  const directoryDisk = bytes.readUInt16LE(end + 6)
  const entriesOnDisk = bytes.readUInt16LE(end + 8)
  const entryCount = bytes.readUInt16LE(end + 10)
  const directoryBytes = bytes.readUInt32LE(end + 12)
  const directoryOffset = bytes.readUInt32LE(end + 16)
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw workbookError('Multi-disk XLSX containers are not accepted')
  }
  if (entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw workbookError('ZIP64 XLSX containers are not accepted')
  }
  if (entryCount === 0 || entryCount > WORKBOOK_LIMITS.zipEntries) {
    throw workbookError(`Workbook ZIP entry count exceeds ${WORKBOOK_LIMITS.zipEntries}`)
  }
  if (directoryOffset + directoryBytes > end) throw workbookError('Malformed XLSX ZIP directory bounds')
  return { end, entryCount, directoryBytes, directoryOffset }
}

function validateArchiveEntryPath(name: string): void {
  const pathSegments = name.split('/')
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
    || pathSegments.includes('..')) {
    throw workbookError('Unsafe XLSX entry path')
  }
}

function readZipEntry(bytes: Buffer, offset: number, directoryEnd: number): ParsedZipEntry {
  if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) {
    throw workbookError('Malformed XLSX ZIP central-directory entry')
  }
  const flags = bytes.readUInt16LE(offset + 8)
  const method = bytes.readUInt16LE(offset + 10)
  const compressed = bytes.readUInt32LE(offset + 20)
  const expanded = bytes.readUInt32LE(offset + 24)
  const nameLength = bytes.readUInt16LE(offset + 28)
  const extraLength = bytes.readUInt16LE(offset + 30)
  const commentLength = bytes.readUInt16LE(offset + 32)
  const diskStart = bytes.readUInt16LE(offset + 34)
  const nextOffset = offset + 46 + nameLength + extraLength + commentLength
  if (nextOffset > directoryEnd || nameLength === 0) throw workbookError('Malformed XLSX ZIP entry bounds')
  if ((flags & 0x0001) !== 0) throw workbookError('Encrypted XLSX entries are not accepted')
  if (method !== 0 && method !== 8) throw workbookError('Unsupported XLSX compression method')
  if (diskStart !== 0 || compressed === 0xffffffff || expanded === 0xffffffff) {
    throw workbookError('ZIP64 or multi-disk XLSX entries are not accepted')
  }
  const encoding = (flags & 0x0800) !== 0 ? 'utf8' : 'latin1'
  const name = bytes.toString(encoding, offset + 46, offset + 46 + nameLength)
  validateArchiveEntryPath(name)
  return { entry: { name, expanded }, nextOffset }
}

function validateRequiredXlsxEntries(entries: readonly ZipEntry[]): void {
  const names = new Set(entries.map(entry => entry.name))
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']) {
    if (!names.has(required)) throw workbookError('ZIP container is not a valid XLSX workbook')
  }
  const hasForbiddenContent = entries.some(entry =>
    /(^|\/)(vbaproject\.bin|activex|embeddings|externalLinks)(\/|$)/i.test(entry.name)
    || (/\.bin$/i.test(entry.name) && !/^xl\/printerSettings\/printerSettings\d+\.bin$/i.test(entry.name))
  )
  if (hasForbiddenContent) {
    throw workbookError('Macro, embedded-object, ActiveX, and external-link workbook content is not accepted')
  }
}

function validateZipDirectory(bytes: Buffer): ZipEntry[] {
  const directory = readZipDirectory(bytes)

  let offset = directory.directoryOffset
  let totalExpanded = 0
  const entries: ZipEntry[] = []
  for (let index = 0; index < directory.entryCount; index += 1) {
    const parsed = readZipEntry(bytes, offset, directory.end)
    totalExpanded += parsed.entry.expanded
    if (parsed.entry.expanded > WORKBOOK_LIMITS.largestEntryBytes || totalExpanded > WORKBOOK_LIMITS.expandedBytes) {
      throw workbookError('Workbook expanded content exceeds the configured safety limit')
    }
    entries.push(parsed.entry)
    offset = parsed.nextOffset
  }
  if (offset !== directory.directoryOffset + directory.directoryBytes) {
    throw workbookError('Malformed XLSX ZIP directory size')
  }
  validateRequiredXlsxEntries(entries)
  return entries
}

async function loadValidatedZip(bytes: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false })
  } catch {
    throw workbookError('Malformed XLSX/OOXML content')
  }
}

async function validateOoxmlContentTypes(zip: JSZip): Promise<void> {
  const contentTypes = await zip.file('[Content_Types].xml')?.async('string')
  if (!contentTypes || /macroEnabled|vbaProject/i.test(contentTypes)) {
    throw workbookError('Macro-enabled workbooks are not accepted')
  }
}

async function validateWorkbookRelationships(zip: JSZip): Promise<void> {
  const relationshipFiles = Object.values(zip.files).filter(entry => !entry.dir && /\.rels$/i.test(entry.name))
  for (const relationship of relationshipFiles) {
    const xml = await relationship.async('string')
    if (/TargetMode\s*=\s*["']External["']/i.test(xml)) {
      throw workbookError('External OOXML relationships are not accepted')
    }
  }
}

async function validateOoxml(bytes: Buffer): Promise<void> {
  validateZipDirectory(bytes)
  const zip = await loadValidatedZip(bytes)
  await validateOoxmlContentTypes(zip)
  await validateWorkbookRelationships(zip)
}

export function inspectCellValue(cell: ExcelJS.Cell): WorkbookCell {
  const value = cell.value
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    throw workbookError('Formulas are not accepted in annual import workbooks')
  }
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text).join('')
  }
  if (typeof value === 'object' && 'error' in value) throw workbookError('Spreadsheet error cells are not accepted')
  throw workbookError('Unsupported spreadsheet cell value is not accepted')
}

function jsonValue(value: WorkbookCell): RawJsonValue {
  return value instanceof Date ? value.toISOString() : value
}

function characterLength(value: WorkbookCell): number {
  if (value === null) return 0
  return value instanceof Date ? value.toISOString().length : String(value).length
}

type HeaderCandidate = {
  sheet: ExcelJS.Worksheet
  rowNumber: number
  values: unknown[]
  validation: HeaderValidationResult
  score: number
}

async function readWorkbookFile(file: string): Promise<{
  resolved: string
  basename: string
  bytes: Buffer
  sourceSha256: string
}> {
  const resolved = path.resolve(file)
  const basename = path.basename(resolved)
  if (path.extname(resolved).toLowerCase() !== '.xlsx') {
    throw workbookError('Only the approved .xlsx workbook format is accepted; .xlsm and .xls are rejected')
  }
  if (/[\x00-\x1f\x7f]/u.test(basename) || basename.length > 500) {
    throw workbookError('Workbook filename is not accepted')
  }
  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) throw workbookError('Import path must point to a regular file')
  if (fileStat.size <= 0 || fileStat.size > WORKBOOK_LIMITS.fileBytes) {
    throw workbookError(`Workbook size must be between 1 byte and ${WORKBOOK_LIMITS.fileBytes} bytes`)
  }
  const bytes = await readFile(resolved)
  return { resolved, basename, bytes, sourceSha256: createHash('sha256').update(bytes).digest('hex') }
}

async function loadWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch (error) {
    if (error instanceof AppError) throw error
    throw workbookError('Malformed XLSX workbook structure')
  }
  if (workbook.worksheets.length === 0 || workbook.worksheets.length > WORKBOOK_LIMITS.worksheets) {
    throw workbookError(`Workbook must contain 1-${WORKBOOK_LIMITS.worksheets} worksheets`)
  }
  return workbook
}

function validateWorksheetDimensions(sheet: ExcelJS.Worksheet): void {
  if (sheet.actualColumnCount > WORKBOOK_LIMITS.columns) {
    throw workbookError(`A worksheet exceeds ${WORKBOOK_LIMITS.columns} columns`)
  }
}

function headerValues(sheet: ExcelJS.Worksheet, rowNumber: number): unknown[] {
  const values: unknown[] = []
  sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    values[columnNumber - 1] = inspectCellValue(cell)
  })
  return values
}

function headerCandidates(workbook: ExcelJS.Workbook, year: number): HeaderCandidate[] {
  const candidates: HeaderCandidate[] = []
  for (const sheet of workbook.worksheets) {
    validateWorksheetDimensions(sheet)
    const lastHeaderRow = Math.min(WORKBOOK_LIMITS.headerSearchRows, sheet.actualRowCount)
    for (let rowNumber = 1; rowNumber <= lastHeaderRow; rowNumber += 1) {
      const values = headerValues(sheet, rowNumber)
      const validation = validateHeaders(values, year)
      const matchedFieldCount = Object.keys(validation.fieldToColumn).length
      if (matchedFieldCount >= 10) {
        candidates.push({
          sheet,
          rowNumber,
          values,
          validation,
          score: matchedFieldCount
        })
      }
    }
  }
  return candidates
}

function selectBusinessHeader(candidates: readonly HeaderCandidate[]): HeaderCandidate {
  if (candidates.length === 0) {
    throw workbookError('No worksheet resembles the approved annual import header schema')
  }
  const highestScore = Math.max(...candidates.map(candidate => candidate.score))
  const likely = candidates.filter(candidate => candidate.score === highestScore)
  if (likely.length > 1) {
    throw workbookError('More than one worksheet/header row matches the annual import schema')
  }
  const candidate = likely[0]!
  if (!candidate.validation.valid) {
    const errorDetails = candidate.validation.errors.join('; ')
    throw workbookError(`Annual workbook header validation failed: ${errorDetails}`, 'WORKBOOK_HEADERS_INVALID')
  }
  return candidate
}

function extractRoutingReferenceLabels(workbook: ExcelJS.Workbook): string[] {
  const routingSheet = workbook.worksheets.find(sheet => {
    const name = cleanHeaderString(sheet.name).replace(/[\s/\\-]+/g, '')
    return name === 'نيابةمساعد' || name === 'نيابهمساعد'
  })
  if (!routingSheet) return []

  const labels = new Set<string>()
  const maxRow = Math.min(WORKBOOK_LIMITS.rows, routingSheet.actualRowCount)
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = routingSheet.getRow(rowNumber)
    row.eachCell({ includeEmpty: false }, cell => {
      const val = inspectCellValue(cell)
      if (typeof val === 'string' && val.trim().length > 0) {
        const cleaned = normalizeRoutingLabel(val)
        if (cleaned && cleaned !== 'النيابة/المساعد') {
          labels.add(cleaned)
        }
      }
    })
  }
  return [...labels]
}

function extractSourceRows(
  candidate: HeaderCandidate
): SourceWorkbookRow[] {
  const rows: SourceWorkbookRow[] = []
  const { fieldToColumn } = candidate.validation
  const { experienceReferenceDate, currentJobTenureReferenceDate } = candidate.validation

  for (let rowNumber = candidate.rowNumber + 1; rowNumber <= candidate.sheet.actualRowCount; rowNumber += 1) {
    const source = candidate.sheet.getRow(rowNumber)
    const values = new Map<string, WorkbookCell>()
    const raw: Record<string, RawJsonValue> = {}
    let hasAnyData = false

    for (const [field, column] of Object.entries(fieldToColumn) as Array<[ImportSemanticField, number]>) {
      const cell = source.getCell(column)
      const value = inspectCellValue(cell)
      if (characterLength(value) > WORKBOOK_LIMITS.cellCharacters) {
        throw workbookError(`A workbook cell exceeds ${WORKBOOK_LIMITS.cellCharacters} characters`)
      }
      values.set(field, value)
      raw[field] = jsonValue(value)
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        hasAnyData = true
      }
    }

    // Skip structurally empty rows
    if (!hasAnyData) continue

    rows.push({
      sourceRowNumber: rowNumber,
      raw,
      values,
      experienceReferenceDate,
      currentJobTenureReferenceDate
    })
    if (rows.length > WORKBOOK_LIMITS.rows) {
      throw workbookError(`Workbook exceeds ${WORKBOOK_LIMITS.rows} data rows`)
    }
  }

  if (rows.length === 0) throw workbookError('Annual workbook contains no data rows')
  return rows
}

export async function inspectAnnualWorkbook(file: string, year: number): Promise<WorkbookInspection> {
  const { resolved, basename, bytes, sourceSha256 } = await readWorkbookFile(file)
  await validateOoxml(bytes)
  const workbook = await loadWorkbook(bytes)
  const candidate = selectBusinessHeader(headerCandidates(workbook, year))
  const rows = extractSourceRows(candidate)
  const workbookRoutingLabels = extractRoutingReferenceLabels(workbook)

  return {
    file: resolved,
    basename,
    sourceSha256,
    year,
    sheetName: candidate.sheet.name,
    headerRowNumber: candidate.rowNumber,
    rowCount: rows.length,
    headers: candidate.validation,
    rows,
    workbookRoutingLabels,
    experienceReferenceDate: candidate.validation.experienceReferenceDate,
    currentJobTenureReferenceDate: candidate.validation.currentJobTenureReferenceDate
  }
}

import { inspectAnnualWorkbook } from './workbook-inspector.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const file = argument('--file')
  const yearText = argument('--year')
  if (!file || !yearText) {
    throw new Error('Usage: npm run data:import -- --file <xlsx> --year <YYYY>')
  }

  const year = Number(yearText)
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error('Import year must be an integer between 2000 and 2200')
  }

  const inspection = await inspectAnnualWorkbook(file, year)
  console.info(JSON.stringify({
    phase: 'validation-only-foundation',
    file: inspection.file,
    year: inspection.year,
    sheetName: inspection.sheetName,
    rowCount: inspection.rowCount,
    detectedHeaders: inspection.headers.normalizedHeaders,
    unexpectedHeaders: inspection.headers.unexpected,
    databaseWrites: false,
    nextStep: 'Implement transactional staging, alias resolution, validation report, and explicit activation in Phase 2.'
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Annual workbook inspection failed')
  process.exitCode = 1
})

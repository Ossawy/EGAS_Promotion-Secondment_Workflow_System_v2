import { randomUUID } from 'node:crypto'
import { loadConfig } from '../../config/env.ts'
import { closePool, getPool } from '../../db/pool.ts'
import { runCli } from '../../shared/run-cli.ts'
import { ImportService } from './import-service.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const file = argument('--file')
  const yearText = argument('--year')
  const operator = argument('--operator')
  if (!file || !yearText || !operator) {
    throw new Error('Usage: npm run data:import -- --file <xlsx> --year <YYYY> --operator <username>')
  }
  const year = Number(yearText)
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error('Import year must be an integer between 2000 and 2200')
  }
  const service = new ImportService(getPool(loadConfig()))
  const result = await service.stageWorkbook(file, year, operator, {
    ipAddress: null, userAgent: 'egas-data-import-cli', correlationId: randomUUID()
  })
  console.info(JSON.stringify(result, null, 2))
}

await runCli(main, closePool, 'Annual workbook import failed')

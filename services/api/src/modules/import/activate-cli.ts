import { randomUUID } from 'node:crypto'
import { loadConfig } from '../../config/env.ts'
import { closePool, getPool } from '../../db/pool.ts'
import { ImportService } from './import-service.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const batch = argument('--batch')
  const operator = argument('--operator')
  if (!batch || !operator) throw new Error('Usage: npm run data:activate -- --batch <UUID> --operator <username>')
  const service = new ImportService(getPool(loadConfig()))
  const actor = await service.operator(operator)
  const result = await service.activate(batch, actor, {
    ipAddress: null, userAgent: 'egas-data-activate-cli', correlationId: randomUUID()
  })
  console.info(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Annual import activation failed')
  process.exitCode = 1
}).finally(closePool)

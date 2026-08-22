import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  LOCAL_DATABASE,
  LOCAL_OWNER,
  LOCAL_RUNTIME,
  formatEnv,
  checkPort,
  isLocalHost,
  localConnectionFromEnv,
  parseEnvText,
  writeExclusive
} from '../scripts/local-dev-lib.mjs'
import { generateDevWorkbook } from '../scripts/generate-dev-workbook.mjs'
import { inspectAnnualWorkbook } from '../src/modules/import/workbook-inspector.js'
import { normalizeStagingRow } from '../src/modules/import/normalization.js'

describe('reproducible local development helpers', () => {
  it('round-trips generated local environment files and enforces fixed local role separation', () => {
    const text = formatEnv({
      EGAS_MIGRATION_HOST: '127.0.0.1',
      EGAS_MIGRATION_PORT: '5432',
      EGAS_MIGRATION_NAME: LOCAL_DATABASE,
      EGAS_MIGRATION_USER: LOCAL_OWNER,
      EGAS_MIGRATION_PASSWORD: 'synthetic_local_owner_password_123456'
    }, 'test')
    const env = parseEnvText(text)
    expect(localConnectionFromEnv(env, 'owner')).toMatchObject({ database: LOCAL_DATABASE, user: LOCAL_OWNER })
    expect(LOCAL_OWNER).not.toBe(LOCAL_RUNTIME)
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('database.example.com')).toBe(false)
    expect(() => localConnectionFromEnv({ ...env, EGAS_MIGRATION_HOST: 'database.example.com' }, 'owner')).toThrow('Refusing non-local')
  })

  it('never overwrites an existing local secret file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'egas-local-setup-test-'))
    const file = path.join(directory, 'secret.env')
    try {
      await writeExclusive(file, 'first-value\n')
      await expect(writeExclusive(file, 'rotated-value\n')).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(file, 'utf8')).toBe('first-value\n')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('detects an IPv6 wildcard listener instead of reporting a false-free port', async () => {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '::', resolve)
    })
    try {
      const address = server.address()
      expect(typeof address).toBe('object')
      expect((await checkPort(address.port)).available).toBe(false)
    } finally { await new Promise(resolve => server.close(resolve)) }
  })

  it('generates an importer-compatible warning-free workbook including جيد', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'egas-dev-workbook-test-'))
    const file = path.join(directory, 'synthetic.xlsx')
    const routing = [
      { nameAr: 'نيابة القاهرة' },
      { nameAr: 'نيابة الإسكندرية' }
    ]
    const employees = [
      { personnelNumber: 'DEV1001', name: 'مرشح أول', routingName: routing[0].nameAr, jobTitle: 'مهندس' },
      { personnelNumber: 'DEV1002', name: 'مرشح ثان', routingName: routing[0].nameAr, jobTitle: 'أخصائي' },
      { personnelNumber: 'DEV2001', name: 'مرشح ثالث', routingName: routing[1].nameAr, jobTitle: 'باحث' }
    ]
    try {
      await generateDevWorkbook(file, 2026, routing, employees)
      const inspection = await inspectAnnualWorkbook(file, 2026)
      expect(inspection.sheetName).toBe('البيانات الاساسية')
      expect(inspection.workbookRoutingLabels).toEqual(expect.arrayContaining(routing.map(item => item.nameAr)))
      const index = {
        targetsByNormalizedLabel: new Map(routing.map((item, position) => [item.nameAr, [{ id: `routing-${position}`, nameAr: item.nameAr }]]))
      }
      const normalized = inspection.rows.map(row => normalizeStagingRow(row, 2026, index))
      expect(normalized.map(row => row.performanceRating)).toContain('جيد')
      expect(normalized.every(row => row.validationStatus === 'VALID' && row.validationMessages.length === 0)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

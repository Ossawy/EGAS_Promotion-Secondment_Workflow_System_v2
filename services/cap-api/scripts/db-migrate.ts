import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cds from '@sap/cds'

type MigrationRow = {
  version: string
  sha256: string
}

async function main(): Promise<void> {
  const kind = cds.env.requires?.db?.kind
  if (kind !== 'postgres') {
    throw new Error(`db:migrate requires PostgreSQL; effective database kind is ${String(kind)}`)
  }

  const model = await cds.load('*')
  const db = await cds.connect.to('db')

  const legacyTables = await db.run(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE (table_schema = 'egas' AND table_name = 'routing_unit')
       OR (table_schema = 'public' AND table_name = 'egas_routingunit')
  `) as Array<{ table_schema: string, table_name: string }>
  const hasLogicalBaseline = legacyTables.some(row =>
    row.table_schema === 'egas' && row.table_name === 'routing_unit'
  )
  const hasCapSchema = legacyTables.some(row =>
    row.table_schema === 'public' && row.table_name === 'egas_routingunit'
  )
  if (hasLogicalBaseline && !hasCapSchema) {
    throw new Error(
      'The frozen handwritten egas.routing_unit schema exists but the CAP persistence schema does not. ' +
      'Migration is intentionally blocked to avoid creating two competing schemas. ' +
      'Back up and verify this development database, then recreate only the confirmed-empty development database ' +
      'or perform an explicitly reviewed one-time data migration.'
    )
  }
  if (hasLogicalBaseline && hasCapSchema) {
    throw new Error(
      'Both handwritten egas.* and CAP egas_* schemas are present. Resolve this duplicate source-of-truth state ' +
      'through a reviewed data migration before running db:migrate.'
    )
  }

  // CAP owns model evolution and reference-data deployment.
  const deploy = (
    cds as typeof cds & {
      deploy: (modelToDeploy: typeof model) => {
        to: (target: typeof db) => Promise<unknown>
      }
    }
  ).deploy
  await deploy(model).to(db)

  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../db/migrations'
  )
  const files = (await readdir(migrationsDir))
    .filter(file => /^\d+.*\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b))

  for (const file of files) {
    const version = path.basename(file, '.sql')
    const sql = await readFile(path.join(migrationsDir, file), 'utf8')
    const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex')
    const applied = await db.run(
      SELECT.one.from('egas.SchemaMigration').where({ version })
    ) as MigrationRow | undefined

    if (applied) {
      if (applied.sha256 !== sha256) {
        throw new Error(`Applied migration ${version} has changed; create a new migration instead`)
      }
      console.info(`Migration ${version}: already applied`)
      continue
    }

    await db.tx(async tx => {
      await tx.run(sql)
      await tx.run(INSERT.into('egas.SchemaMigration').entries({
        version,
        sha256,
        appliedAt: new Date().toISOString()
      }))
    })
    console.info(`Migration ${version}: applied`)
  }
}

const shutdown = (): Promise<unknown> | unknown => (
  cds as typeof cds & { shutdown: () => Promise<unknown> | unknown }
).shutdown()

main()
  .then(() => shutdown())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : 'Database migration failed')
    await shutdown()
    process.exitCode = 1
  })

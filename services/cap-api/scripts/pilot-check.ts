import cds from '@sap/cds'

interface CheckResult {
  check: string
  ok: boolean
  detail: string
}

async function main(): Promise<void> {
  const results: CheckResult[] = []
  const credentials = cds.env.requires?.db?.credentials ?? {}
  const dbUser = String(credentials.user ?? '')
  results.push({
    check: 'database runtime role',
    ok: Boolean(dbUser) && dbUser.toLowerCase() !== 'postgres',
    detail: dbUser ? `configured as ${dbUser}` : 'database user is missing'
  })

  const db = await cds.connect.to('db')
  const routingUnits = await db.run(
    SELECT.from('egas.RoutingUnit').columns('ID').where({ isActive: true })
  ) as Array<{ ID: string }>
  results.push({
    check: 'active routing units',
    ok: routingUnits.length === 22,
    detail: `${routingUnits.length}/22 active`
  })

  const privilegedRoles = await db.run(
    SELECT.from('egas.UserAccountRole')
      .columns('user_ID')
      .where({ role: 'ADMIN', canManageAdmins: true, isActive: true })
  ) as Array<{ user_ID: string }>
  let activePrivilegedAdmins = 0
  for (const role of privilegedRoles) {
    const account = await db.run(
      SELECT.one.from('egas.UserAccount').columns('ID').where({ ID: role.user_ID, isActive: true })
    )
    if (account) activePrivilegedAdmins += 1
  }
  results.push({
    check: 'privileged Admin',
    ok: activePrivilegedAdmins >= 1,
    detail: `${activePrivilegedAdmins} active Manage-Admins account(s)`
  })

  const assignments = await db.run(
    SELECT.from('egas.ApprovingAuthorityAssignment')
      .columns('routingUnit_ID')
      .where({ isPrimary: true, isActive: true })
  ) as Array<{ routingUnit_ID: string }>
  const coveredUnits = new Set(assignments.map(row => row.routingUnit_ID))
  results.push({
    check: 'authority coverage',
    ok: routingUnits.every(unit => coveredUnits.has(unit.ID)),
    detail: `${coveredUnits.size}/${routingUnits.length} active routing units covered`
  })

  const expectedYear = Number(process.env.EGAS_ACTIVE_SNAPSHOT_YEAR)
  const activeBatches = await db.run(
    SELECT.from('egas.ImportBatch')
      .columns('snapshotYear')
      .where({ status: 'ACTIVATED' })
  ) as Array<{ snapshotYear: number }>
  const snapshotOk = Number.isInteger(expectedYear)
    ? activeBatches.some(batch => batch.snapshotYear === expectedYear)
    : activeBatches.length >= 1
  results.push({
    check: 'active annual snapshot',
    ok: snapshotOk,
    detail: activeBatches.length
      ? `active year(s): ${activeBatches.map(batch => batch.snapshotYear).join(', ')}`
      : 'none activated'
  })

  console.table(results)
  if (results.some(result => !result.ok)) process.exitCode = 1
}

const shutdown = (): Promise<unknown> | unknown => (
  cds as typeof cds & { shutdown: () => Promise<unknown> | unknown }
).shutdown()

main()
  .then(() => shutdown())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : 'Pilot preflight failed')
    await shutdown()
    process.exitCode = 1
  })

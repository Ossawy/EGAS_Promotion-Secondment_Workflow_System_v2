import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createApp } from '../src/app.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { isolatedPool, testConfig } from './helpers/database.js'

let pool: Pool
let server: Server
let origin: string
let unit: { id: string, nameAr: string }
const password = 'synthetic-current-password'

async function account(username: string, roles: string[]): Promise<string> {
  const provider = new LocalAuthenticationProvider(pool, testConfig)
  const id = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [id, username, await provider.hashPassword(password)]
  )
  for (const role of roles) {
    await pool.query(
      `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
       VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [randomUUID(), id, role]
    )
  }
  return id
}

function cookies(response: Response): { cookie: string, csrf: string } {
  const values = response.headers.getSetCookie().map(value => value.split(';', 1)[0]!)
  const cookie = values.join('; ')
  const csrf = values.find(value => value.startsWith(`${testConfig.auth.csrfCookieName}=`))!.split('=', 2)[1]!
  return { cookie, csrf }
}

async function login(username: string): Promise<{ cookie: string, csrf: string }> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, password })
  })
  expect(response.status).toBe(200)
  return cookies(response)
}

async function selectRole(auth: { cookie: string, csrf: string }, role: string) {
  const response = await fetch(`${origin}/api/auth/select-active-role`, {
    method: 'POST', headers: {
      'content-type': 'application/json', origin, cookie: auth.cookie, 'x-csrf-token': auth.csrf
    }, body: JSON.stringify({ role })
  })
  expect(response.status).toBe(200)
  return cookies(response)
}

beforeEach(async () => {
  pool = await isolatedPool()
  await account('phase2b-route-admin', ['ADMIN'])
  await account('phase2b-route-multi', ['ADMIN','ORGANIZATION'])
  await account('phase2b-route-ea', ['EMPLOYEE_AFFAIRS'])
  unit = (await pool.query<{ id: string, nameAr: string }>(
    `SELECT id,namear AS "nameAr" FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 1`
  )).rows[0]!
  server = createServer(createApp(pool, testConfig))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await pool.end()
})

describe('Phase 2B REST authorization and safe DTOs', () => {
  it('43. makes alias create/update/deactivate Admin-only, CSRF-protected, and auditable', async () => {
    const admin = await login('phase2b-route-admin')
    const body = JSON.stringify({ sourceLabel: 'مصدر API اختباري', routingUnitId: unit.id })
    expect((await fetch(`${origin}/api/admin/routing-aliases`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie: admin.cookie }, body
    })).status).toBe(403)
    const createdResponse = await fetch(`${origin}/api/admin/routing-aliases`, {
      method: 'POST', headers: {
        'content-type': 'application/json', origin, cookie: admin.cookie, 'x-csrf-token': admin.csrf
      }, body
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string }
    const updated = await fetch(`${origin}/api/admin/routing-aliases/${created.id}`, {
      method: 'PATCH', headers: {
        'content-type': 'application/json', origin, cookie: admin.cookie, 'x-csrf-token': admin.csrf
      }, body: JSON.stringify({ notes: 'synthetic note' })
    })
    expect(updated.status).toBe(200)
    const deactivated = await fetch(`${origin}/api/admin/routing-aliases/${created.id}/deactivate`, {
      method: 'POST', headers: {
        'content-type': 'application/json', origin, cookie: admin.cookie, 'x-csrf-token': admin.csrf
      }, body: '{}'
    })
    expect(deactivated.status).toBe(200)
    expect(await deactivated.json()).toMatchObject({ id: created.id, isActive: false })
    const events = await pool.query(`SELECT eventtype FROM egas_securityevent WHERE eventtype LIKE 'ROUTING_ALIAS_%'`)
    expect(events.rows.map(row => row.eventtype)).toEqual(expect.arrayContaining([
      'ROUTING_ALIAS_CREATED','ROUTING_ALIAS_UPDATED','ROUTING_ALIAS_DEACTIVATED'
    ]))
  })

  it('44. does not union an assigned ADMIN role into a session active as ORGANIZATION', async () => {
    const initial = await login('phase2b-route-multi')
    const organization = await selectRole(initial, 'ORGANIZATION')
    expect((await fetch(`${origin}/api/admin/routing-aliases`, { headers: { cookie: organization.cookie } })).status).toBe(403)
    expect((await fetch(`${origin}/api/admin/import-batches`, { headers: { cookie: organization.cookie } })).status).toBe(403)
    expect((await fetch(`${origin}/api/admin/routing-aliases`, {
      method: 'POST', headers: {
        'content-type': 'application/json', origin, cookie: organization.cookie, 'x-csrf-token': organization.csrf
      }, body: JSON.stringify({ sourceLabel: 'denied', routingUnitId: unit.id })
    })).status).toBe(403)
  })

  it('45. limits active-snapshot Personnel lookup to Employee Affairs and returns no raw database object', async () => {
    const batchId = randomUUID()
    const employeeId = randomUUID()
    await pool.query(
      `INSERT INTO egas_importbatch
        (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,
         importedat,status,totalrows,validrows,warningrows,blockedrows)
       VALUES ($1,2026,'synthetic.xlsx',$2,TRUE,'[]'::jsonb,CURRENT_TIMESTAMP,'ACTIVATED',1,1,0,0)`,
      [batchId, 'a'.repeat(64)]
    )
    await pool.query(`INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,'000123',CURRENT_TIMESTAMP)`, [employeeId])
    await pool.query(
      `INSERT INTO egas_employeeannualsnapshot
        (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,sourceroutingunit,
         routingunit_id,performancerating,createdat)
       VALUES ($1,$2,$3,2026,'000123','موظف API اختباري',$4,$5,'ممتاز',CURRENT_TIMESTAMP)`,
      [randomUUID(), employeeId, batchId, unit.nameAr, unit.id]
    )
    const employeeAffairs = await login('phase2b-route-ea')
    const response = await fetch(`${origin}/api/employee-data/employees/000123`, { headers: { cookie: employeeAffairs.cookie } })
    expect(response.status).toBe(200)
    const dto = await response.json()
    expect(dto).toMatchObject({ snapshotYear: 2026, personnelNumber: '000123', routingUnit: { id: unit.id } })
    expect(JSON.stringify(dto)).not.toMatch(/rawjson|password|session|importbatch|sourcesha256/i)
    const admin = await login('phase2b-route-admin')
    expect((await fetch(`${origin}/api/employee-data/employees/000123`, { headers: { cookie: admin.cookie } })).status).toBe(403)
    expect((await fetch(`${origin}/api/employee-data/active-snapshot`)).status).toBe(401)
  })
})

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createApp } from '../src/app.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { createNotification } from '../src/modules/notifications/notification-service.js'
import { isolatedPool, testConfig } from './helpers/database.js'

let pool: Pool; let server: Server; let origin: string
const password = 'synthetic-current-password'
const users = new Map<string, string>()

async function account(username: string, roles: string[]): Promise<void> {
  const id = randomUUID(); users.set(username, id); const provider = new LocalAuthenticationProvider(pool, testConfig)
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [id, username, await provider.hashPassword(password)]
  )
  for (const role of roles) await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [randomUUID(), id, role]
  )
}

function sessionCookies(response: Response) {
  const values = response.headers.getSetCookie().map(value => value.split(';', 1)[0]!)
  const csrf = values.find(value => value.startsWith(`${testConfig.auth.csrfCookieName}=`))!.split('=', 2)[1]!
  return { cookie: values.join('; '), csrf }
}

async function login(username: string, select?: string) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, password }) })
  let auth = sessionCookies(response)
  if (select) {
    const selected = await fetch(`${origin}/api/auth/select-active-role`, { method: 'POST', headers: {
      'content-type': 'application/json', origin, cookie: auth.cookie, 'x-csrf-token': auth.csrf
    }, body: JSON.stringify({ role: select }) })
    auth = sessionCookies(selected)
  }
  return auth
}

function jsonHeaders(auth: { cookie: string, csrf: string }, csrf = true): Record<string, string> {
  return { 'content-type': 'application/json', origin, cookie: auth.cookie,
    ...(csrf ? { 'x-csrf-token': auth.csrf } : {}) }
}

async function createRequest(auth: { cookie: string, csrf: string }) {
  const response = await fetch(`${origin}/api/workflow/requests`, { method: 'POST', headers: jsonHeaders(auth),
    body: JSON.stringify({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }) })
  return { response, body: await response.json() as Record<string, unknown> }
}

beforeEach(async () => {
  users.clear(); pool = await isolatedPool()
  await account('api-ea', ['EMPLOYEE_AFFAIRS']); await account('api-other-ea', ['EMPLOYEE_AFFAIRS'])
  await account('api-admin', ['ADMIN']); await account('api-multi', ['ADMIN','EMPLOYEE_AFFAIRS'])
  await account('api-org', ['ORGANIZATION'])
  server = createServer(createApp(pool, testConfig)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  origin = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await pool.end()
})

describe('Phase 3A REST boundary', () => {
  it('requires authentication, exact EA active role, and CSRF for request creation', async () => {
    expect((await fetch(`${origin}/api/workflow/requests`)).status).toBe(401)
    const admin = await login('api-admin')
    expect((await fetch(`${origin}/api/workflow/requests`, { method: 'POST', headers: jsonHeaders(admin), body: '{}' })).status).toBe(403)
    const activeAdmin = await login('api-multi', 'ADMIN')
    expect((await fetch(`${origin}/api/workflow/requests`, { method: 'POST', headers: jsonHeaders(activeAdmin), body: '{}' })).status).toBe(403)
    const ea = await login('api-ea')
    expect((await fetch(`${origin}/api/workflow/requests`, { method: 'POST', headers: jsonHeaders(ea, false),
      body: JSON.stringify({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }) })).status).toBe(403)
    expect((await createRequest(ea)).response.status).toBe(201)
  })

  it('validates request bodies and never accepts browser-supplied employee master fields', async () => {
    const ea = await login('api-ea'); const created = await createRequest(ea)
    const invalid = await fetch(`${origin}/api/workflow/requests/${created.body.id}/candidates`, { method: 'POST', headers: jsonHeaders(ea),
      body: JSON.stringify({ personnelNumber: '100', employeeName: 'forged', routingUnitId: randomUUID() }) })
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: { code: 'EGAS_REQUEST_REJECTED' } })
    expect((await pool.query('SELECT id FROM egas_requestcandidate')).rows).toHaveLength(0)
  })

  it('protects owner-scoped request, candidate, note, and timeline IDs from another EA', async () => {
    const owner = await login('api-ea'); const other = await login('api-other-ea'); const created = await createRequest(owner)
    const paths = ['', '/notes', '/timeline', '/authority-options']
    for (const suffix of paths) {
      expect((await fetch(`${origin}/api/workflow/requests/${created.body.id}${suffix}`, { headers: { cookie: other.cookie } })).status).toBe(404)
    }
    const directCandidate = await fetch(`${origin}/api/workflow/requests/${created.body.id}/candidates/${randomUUID()}`, {
      method: 'DELETE', headers: jsonHeaders(other), body: '{}'
    })
    expect(directCandidate.status).toBe(404)
  })

  it('provides no submit/downstream transition or note mutation route', async () => {
    const ea = await login('api-ea'); const created = await createRequest(ea); const id = created.body.id
    for (const path of [`/api/workflow/requests/${id}/submit`, `/api/workflow/requests/${id}/transition`,
      `/api/workflow/requests/${id}/notes/${randomUUID()}`]) {
      expect((await fetch(`${origin}${path}`, { method: 'POST', headers: jsonHeaders(ea), body: '{}' })).status).toBe(404)
      expect((await fetch(`${origin}${path}`, { method: 'DELETE', headers: jsonHeaders(ea), body: '{}' })).status).toBe(404)
    }
  })

  it('restricts Organization queue and isolates notification read state through the API', async () => {
    const ea = await login('api-ea'); const org = await login('api-org')
    expect((await fetch(`${origin}/api/workflow/organization/queue`, { headers: { cookie: ea.cookie } })).status).toBe(403)
    expect((await fetch(`${origin}/api/workflow/organization/queue`, { headers: { cookie: org.cookie } })).status).toBe(200)
    const ownId = await createNotification(pool, { recipientUserId: users.get('api-ea')!, type: 'TEST', titleAr: 'اختبار' })
    const foreignId = await createNotification(pool, { recipientUserId: users.get('api-other-ea')!, type: 'TEST', titleAr: 'آخر' })
    const listed = await fetch(`${origin}/api/notifications?unreadOnly=true`, { headers: { cookie: ea.cookie } })
    expect(await listed.json()).toEqual([expect.objectContaining({ id: ownId, isRead: false })])
    expect((await fetch(`${origin}/api/notifications/${foreignId}/read`, { method: 'POST', headers: jsonHeaders(ea), body: '{}' })).status).toBe(404)
    expect((await fetch(`${origin}/api/notifications/${ownId}/read`, { method: 'POST', headers: jsonHeaders(ea), body: '{}' })).status).toBe(200)
  })
})

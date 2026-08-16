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

async function account(username: string, role: string): Promise<void> {
  const provider = new LocalAuthenticationProvider(pool, testConfig)
  const id = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [id, username, await provider.hashPassword('synthetic-current-password')]
  )
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP)`, [randomUUID(), id, role, role === 'ADMIN']
  )
}

async function login(username: string): Promise<{ cookie: string; setCookies: string[]; body: Record<string, unknown>; csrf: string }> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, password: 'synthetic-current-password' })
  })
  expect(response.status).toBe(200)
  const setCookies = response.headers.getSetCookie()
  const cookie = setCookies.map(value => value.split(';', 1)[0]).join('; ')
  const csrfPair = cookie.split('; ').find(value => value.startsWith(`${testConfig.auth.csrfCookieName}=`))
  return { cookie, setCookies, csrf: csrfPair!.slice(csrfPair!.indexOf('=') + 1), body: await response.json() as Record<string, unknown> }
}

beforeEach(async () => {
  pool = await isolatedPool()
  await account('route-admin', 'ADMIN')
  await account('route-organization', 'ORGANIZATION')
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

describe('explicit REST surface', () => {
  it('answers liveness/readiness and has no OData route', async () => {
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    expect((await fetch(`${origin}/ready`)).status).toBe(200)
    expect((await fetch(`${origin}/odata/v4/admin/Users`)).status).toBe(404)
  })

  it('requires authentication for reference/admin APIs', async () => {
    expect((await fetch(`${origin}/api/reference/routing-units`)).status).toBe(401)
    expect((await fetch(`${origin}/api/admin/users`)).status).toBe(401)
  })

  it('issues hardened cookies without returning raw tokens', async () => {
    const result = await login('route-admin')
    expect(result.cookie).toContain('EGAS_SESSION=')
    expect(result.cookie).toContain('EGAS_SESSION_CSRF=')
    expect(result.setCookies.find(value => value.startsWith('EGAS_SESSION='))).toMatch(/HttpOnly; SameSite=Strict/)
    expect(result.setCookies.find(value => value.startsWith('EGAS_SESSION_CSRF='))).not.toContain('HttpOnly')
    expect(result.setCookies.every(value => value.includes('Path=/') && value.includes('Expires='))).toBe(true)
    expect(JSON.stringify(result.body)).not.toMatch(/sessionToken|csrfToken|passwordHash/)
    expect(result.body).toMatchObject({ activeRole: 'ADMIN' })
    const users = await fetch(`${origin}/api/admin/users`, { headers: { cookie: result.cookie } })
    expect(users.status).toBe(200)
  })

  it('does not union an unselected ADMIN role and enforces CSRF on mutations', async () => {
    const organization = await login('route-organization')
    expect((await fetch(`${origin}/api/admin/users`, { headers: { cookie: organization.cookie } })).status).toBe(403)
    const admin = await login('route-admin')
    const missingCsrf = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST', headers: { cookie: admin.cookie, origin }
    })
    expect(missingCsrf.status).toBe(403)
    const valid = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST', headers: { cookie: admin.cookie, origin, 'x-csrf-token': admin.csrf }
    })
    expect(valid.status).toBe(204)
  })

  it('rejects untrusted origins and mandatory-password accounts fail closed for Admin', async () => {
    const rejected = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: JSON.stringify({ username: 'route-admin', password: 'synthetic-current-password' })
    })
    expect(rejected.status).toBe(403)
    await pool.query("UPDATE egas_useraccount SET mustchangepassword=TRUE WHERE username='route-admin'")
    const admin = await login('route-admin')
    expect(admin.body.mustChangePassword).toBe(true)
    expect((await fetch(`${origin}/api/admin/users`, { headers: { cookie: admin.cookie } })).status).toBe(403)
  })
})

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import sharp from 'sharp'

import { createApp } from '../src/app.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { isolatedPool, testConfig } from './helpers/database.js'

let pool: Pool
let server: Server
let origin: string

async function account(
  username: string,
  role: string
): Promise<void> {
  const provider =
    new LocalAuthenticationProvider(
      pool,
      testConfig
    )

  const id = randomUUID()

  await pool.query(
    `INSERT INTO egas_useraccount
      (
        id,
        username,
        displayname,
        passwordhash,
        mustchangepassword,
        isactive,
        createdat,
        updatedat
      )
     VALUES (
       $1,$2,$2,$3,
       FALSE,
       TRUE,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
     )`,
    [
      id,
      username,
      await provider.hashPassword(
        'synthetic-current-password'
      )
    ]
  )

  await pool.query(
    `INSERT INTO egas_useraccountrole
      (
        id,
        user_id,
        role,
        canmanageadmins,
        isactive,
        grantedat
      )
     VALUES (
       $1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP
     )`,
    [
      randomUUID(),
      id,
      role,
      role === 'ADMIN'
    ]
  )
}

async function login(
  username: string
): Promise<{
  cookie: string
  setCookies: string[]
  body: Record<string, unknown>
  csrf: string
}> {
  const response = await fetch(
    `${origin}/api/auth/login`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin
      },
      body: JSON.stringify({
        username,
        password: 'synthetic-current-password'
      })
    }
  )

  expect(response.status).toBe(200)

  const setCookies =
    response.headers.getSetCookie()

  const cookie =
    setCookies
      .map(
        value =>
          value.split(';', 1)[0]
      )
      .join('; ')

  const csrfPair =
    cookie
      .split('; ')
      .find(
        value =>
          value.startsWith(
            `${testConfig.auth.csrfCookieName}=`
          )
      )

  return {
    cookie,
    setCookies,
    csrf:
      csrfPair!.slice(
        csrfPair!.indexOf('=') + 1
      ),
    body:
      await response.json() as Record<
        string,
        unknown
      >
  }
}

beforeEach(async () => {
  pool = await isolatedPool()

  await account(
    'route-admin',
    'ADMIN'
  )

  await account(
    'route-organization',
    'ORGANIZATION'
  )

  await account(
    'route-employee-affairs',
    'EMPLOYEE_AFFAIRS'
  )

  server =
    createServer(
      createApp(
        pool,
        testConfig
      )
    )

  await new Promise<void>(
    resolve =>
      server.listen(
        0,
        '127.0.0.1',
        resolve
      )
  )

  const address =
    server.address()

  if (
    !address ||
    typeof address === 'string'
  ) {
    throw new Error(
      'Test server did not bind'
    )
  }

  origin =
    `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>(
    (resolve, reject) =>
      server.close(
        error =>
          error
            ? reject(error)
            : resolve()
      )
  )

  await pool.end()
})

describe(
  'explicit REST surface',
  () => {
    it(
      'answers liveness/readiness and has no OData route',
      async () => {
        expect(
          (
            await fetch(
              `${origin}/health`
            )
          ).status
        ).toBe(200)

        expect(
          (
            await fetch(
              `${origin}/ready`
            )
          ).status
        ).toBe(200)

        expect(
          (
            await fetch(
              `${origin}/odata/v4/admin/Users`
            )
          ).status
        ).toBe(404)
      }
    )

    it(
      'sets defensive browser headers and prevents API response caching',
      async () => {
        const response =
          await fetch(
            `${origin}/api/reference/routing-units`
          )

        expect(
          response.headers.get(
            'x-content-type-options'
          )
        ).toBe('nosniff')

        expect(
          response.headers.get(
            'x-frame-options'
          )
        ).toBe('DENY')

        expect(
          response.headers.get(
            'referrer-policy'
          )
        ).toBe('no-referrer')

        expect(
          response.headers.get(
            'permissions-policy'
          )
        ).toContain('camera=()')

        expect(
          response.headers.get(
            'cache-control'
          )
        ).toBe('no-store')
      }
    )

    it(
      'requires authentication for reference/admin APIs',
      async () => {
        expect(
          (
            await fetch(
              `${origin}/api/reference/routing-units`
            )
          ).status
        ).toBe(401)

        expect(
          (
            await fetch(
              `${origin}/api/admin/users`
            )
          ).status
        ).toBe(401)
      }
    )

    it(
      'issues hardened cookies without returning raw tokens',
      async () => {
        const result =
          await login('route-admin')

        expect(
          result.cookie
        ).toContain(
          'EGAS_SESSION='
        )

        expect(
          result.cookie
        ).toContain(
          'EGAS_SESSION_CSRF='
        )

        expect(
          result.setCookies.find(
            value =>
              value.startsWith(
                'EGAS_SESSION='
              )
          )
        ).toMatch(
          /HttpOnly; SameSite=Strict/
        )

        expect(
          result.setCookies.find(
            value =>
              value.startsWith(
                'EGAS_SESSION_CSRF='
              )
          )
        ).not.toContain(
          'HttpOnly'
        )

        expect(
          result.setCookies.every(
            value =>
              value.includes('Path=/') &&
              value.includes('Expires=')
          )
        ).toBe(true)

        expect(
          JSON.stringify(
            result.body
          )
        ).not.toMatch(
          /sessionToken|csrfToken|passwordHash/
        )

        expect(
          result.body
        ).toMatchObject({
          activeRole: 'ADMIN'
        })

        const users =
          await fetch(
            `${origin}/api/admin/users`,
            {
              headers: {
                cookie: result.cookie
              }
            }
          )

        expect(
          users.status
        ).toBe(200)
      }
    )

    it(
      'does not union an unselected ADMIN role and enforces CSRF on mutations',
      async () => {
        const organization =
          await login(
            'route-organization'
          )

        expect(
          (
            await fetch(
              `${origin}/api/admin/users`,
              {
                headers: {
                  cookie:
                    organization.cookie
                }
              }
            )
          ).status
        ).toBe(403)

        const admin =
          await login('route-admin')

        const missingCsrf =
          await fetch(
            `${origin}/api/auth/logout`,
            {
              method: 'POST',
              headers: {
                cookie:
                  admin.cookie,
                origin
              }
            }
          )

        expect(
          missingCsrf.status
        ).toBe(403)

        const valid =
          await fetch(
            `${origin}/api/auth/logout`,
            {
              method: 'POST',
              headers: {
                cookie:
                  admin.cookie,
                origin,
                'x-csrf-token':
                  admin.csrf
              }
            }
          )

        expect(
          valid.status
        ).toBe(204)
      }
    )

    it(
      'rejects untrusted origins and mandatory-password accounts fail closed for Admin',
      async () => {
        const rejected =
          await fetch(
            `${origin}/api/auth/login`,
            {
              method: 'POST',
              headers: {
                'content-type':
                  'application/json',
                origin:
                  'https://untrusted.invalid'
              },
              body:
                JSON.stringify({
                  username:
                    'route-admin',
                  password:
                    'synthetic-current-password'
                })
            }
          )

        expect(
          rejected.status
        ).toBe(403)

        await pool.query(
          `UPDATE egas_useraccount
              SET mustchangepassword = TRUE
            WHERE username = 'route-admin'`
        )

        const admin =
          await login(
            'route-admin'
          )

        expect(
          admin.body.mustChangePassword
        ).toBe(true)

        expect(
          (
            await fetch(
              `${origin}/api/admin/users`,
              {
                headers: {
                  cookie:
                    admin.cookie
                }
              }
            )
          ).status
        ).toBe(403)
      }
    )

    it(
      'requires fresh password reauthentication for the real signoff endpoint',
      async () => {
        const employeeAffairs =
          await login(
            'route-employee-affairs'
          )

        const mutationHeaders = {
          cookie:
            employeeAffairs.cookie,
          origin,
          'x-csrf-token':
            employeeAffairs.csrf
        }

        /*
         * Create a real P1 Promotion request
         * through the HTTP API.
         */
        const createResponse =
          await fetch(
            `${origin}/api/workflow/requests`,
            {
              method: 'POST',
              headers: {
                ...mutationHeaders,
                'content-type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  requestType:
                    'PROMOTION',
                  cycleYear: 2026,
                  formMonth: 8,
                  formYear: 2026
                })
            }
          )

        expect(
          createResponse.status
        ).toBe(201)

        const request =
          await createResponse.json() as {
            id: string
            currentStage: string
          }

        expect(
          request.currentStage
        ).toBe('P1')

        /*
         * Upload a real signature asset.
         */
        const signatureImage =
          await sharp({
            create: {
              width: 320,
              height: 120,
              channels: 4,
              background:
                '#155e43'
            }
          })
            .png()
            .toBuffer()

        const uploadResponse =
          await fetch(
            `${origin}/api/workflow/signatures`,
            {
              method: 'POST',
              headers: {
                ...mutationHeaders,
                'content-type':
                  'image/png'
              },
              body:
                signatureImage
            }
          )

        expect(
          uploadResponse.status
        ).toBe(201)

        const asset =
          await uploadResponse.json() as {
            id: string
          }

        /*
         * Missing password must fail
         * explicitly and must not sign.
         */
        const missingPasswordResponse =
          await fetch(
            `${origin}/api/workflow/requests/${request.id}/signoff`,
            {
              method: 'POST',
              headers: {
                ...mutationHeaders,
                'content-type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  signatureAssetId:
                    asset.id,
                  jobTitle:
                    'باحث شئون عاملين'
                })
            }
          )

        expect(
          missingPasswordResponse.status
        ).toBe(400)

        expect(
          await missingPasswordResponse.json()
        ).toMatchObject({
          error: {
            code:
              'SIGNATURE_PASSWORD_REQUIRED'
          }
        })

        let signoffs =
          await pool.query<{
            count: string
          }>(
            `SELECT COUNT(*)::text AS count
               FROM egas_workflowsignoff
              WHERE request_id = $1`,
            [
              request.id
            ]
          )

        expect(
          Number(
            signoffs.rows[0]!.count
          )
        ).toBe(0)

        /*
         * Wrong password must return 401,
         * create a security event,
         * and create no signoff.
         */
        const wrongPasswordResponse =
          await fetch(
            `${origin}/api/workflow/requests/${request.id}/signoff`,
            {
              method: 'POST',
              headers: {
                ...mutationHeaders,
                'content-type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  signatureAssetId:
                    asset.id,
                  jobTitle:
                    'باحث شئون عاملين',
                  password:
                    'wrong-current-password'
                })
            }
          )

        expect(
          wrongPasswordResponse.status
        ).toBe(401)

        expect(
          await wrongPasswordResponse.json()
        ).toMatchObject({
          error: {
            code:
              'SIGNATURE_PASSWORD_INVALID'
          }
        })

        signoffs =
          await pool.query<{
            count: string
          }>(
            `SELECT COUNT(*)::text AS count
               FROM egas_workflowsignoff
              WHERE request_id = $1`,
            [
              request.id
            ]
          )

        expect(
          Number(
            signoffs.rows[0]!.count
          )
        ).toBe(0)

        const securityEvents =
          await pool.query<{
            count: string
          }>(
            `SELECT COUNT(*)::text AS count
               FROM egas_securityevent
              WHERE actoruser_id = (
                SELECT id
                  FROM egas_useraccount
                 WHERE username =
                   'route-employee-affairs'
              )
                AND eventtype =
                  'SIGNATURE_PASSWORD_REJECTED'`
          )

        expect(
          Number(
            securityEvents.rows[0]!.count
          )
        ).toBe(1)

        /*
         * The actual current password
         * must permit the immutable signoff.
         */
        const correctPasswordResponse =
          await fetch(
            `${origin}/api/workflow/requests/${request.id}/signoff`,
            {
              method: 'POST',
              headers: {
                ...mutationHeaders,
                'content-type':
                  'application/json'
              },
              body:
                JSON.stringify({
                  signatureAssetId:
                    asset.id,
                  jobTitle:
                    'باحث شئون عاملين',
                  password:
                    'synthetic-current-password'
                })
            }
          )

        expect(
          correctPasswordResponse.status
        ).toBe(201)

        expect(
          await correctPasswordResponse.json()
        ).toMatchObject({
          stageCode: 'P1',
          signatureAssetId:
            asset.id
        })

        signoffs =
          await pool.query<{
            count: string
          }>(
            `SELECT COUNT(*)::text AS count
               FROM egas_workflowsignoff
              WHERE request_id = $1`,
            [
              request.id
            ]
          )

        expect(
          Number(
            signoffs.rows[0]!.count
          )
        ).toBe(1)
      }
    )
  }
)
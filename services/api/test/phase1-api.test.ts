import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { testConfig } from './helpers/database.js'

describe('Phase 1 route retirement', () => {
  it('does not mount active-role selection or workflow routes', async () => {
    const routes = await readFile(new URL('../src/modules/auth/routes.ts', import.meta.url), 'utf8')
    const app = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8')
    expect(routes).not.toContain("router.post('/select-active-role'")
    expect(app).not.toContain("app.use('/api/workflow'")
    expect(testConfig.auth.sessionCookieName).toBe('EGAS_SESSION')
  })
})

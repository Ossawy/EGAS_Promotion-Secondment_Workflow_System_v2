import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { testConfig } from './helpers/database.js'

describe('Route integration and retirement', () => {
  it('keeps active-role selection retired and mounts the v5 workflow router', async () => {
    const routes = await readFile(new URL('../src/modules/auth/routes.ts', import.meta.url), 'utf8')
    const app = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8')

    // Active-role switching remains retired
    expect(routes).not.toContain("router.post('/select-active-role'")

    // Current v5 workflow router is mounted from v5 workflow-routes module
    expect(app).toContain("app.use('/api/workflow', workflowRouter(pool, config))")
    expect(app).toMatch(/import \{ workflowRouter \} from '\.\/modules\/workflow\/workflow-routes/)

    expect(testConfig.auth.sessionCookieName).toBe('EGAS_SESSION')
  })
})

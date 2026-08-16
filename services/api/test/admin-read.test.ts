import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { AdminReadService } from '../src/modules/admin/admin-read-service.ts'

describe('admin read models', () => {
  it('builds truthful pilot readiness from database aggregates', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ totalUsers: 5, activeUsers: 4, disabledUsers: 1, lockedUsers: 1, routingUnitCount: 22, coveredRoutingUnits: 0, activeAliases: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'batch-1', status: 'VALIDATED', snapshotYear: 2026, blockedRows: 2, warningRows: 1, validRows: 19, importedAt: new Date('2026-08-16T10:00:00Z') }] })
      .mockResolvedValueOnce({ rows: [] })
    const service = new AdminReadService({ query } as unknown as Pool)

    const result = await service.overview()

    expect(result).toMatchObject({
      accounts: { total: 5, disabled: 1, locked: 1 }, authorityCoverage: { covered: 0, total: 22 },
      activeSnapshot: { available: false }, pilotReady: false
    })
  })

  it('keeps audit filters parameterized and returns allow-listed records', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'event-1', eventType: 'USER_CREATED', actorUserId: 'actor-1', actorName: 'Admin',
      routingUnitId: null, routingUnitName: null, ipAddress: '127.0.0.1', correlationId: 'corr-1',
      details: { targetUserId: 'user-1' }, createdAt: new Date('2026-08-16T10:00:00Z')
    }] })
    const service = new AdminReadService({ query } as unknown as Pool)

    const rows = await service.audit({ eventType: 'USER_CREATED', actor: 'Admin', from: '2026-08-01', to: '2026-08-16', top: 20 })

    expect(rows[0]).toMatchObject({ eventType: 'USER_CREATED', createdAt: '2026-08-16T10:00:00.000Z' })
    expect(query.mock.calls[0]?.[1]).toEqual(['USER_CREATED', 'Admin', '2026-08-01', '2026-08-16', 20, 0])
    expect(String(query.mock.calls[0]?.[0])).toContain('e.eventtype=$1')
  })
})

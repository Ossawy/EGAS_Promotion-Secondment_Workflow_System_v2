import { describe, expect, it, vi } from 'vitest'
import type { Service } from '@sap/cds'
import { LocalAuthenticationProvider } from '../lib/auth/local-authentication-provider.js'
import { LocalEmployeeDataProvider } from '../lib/employee/local-employee-data-provider.js'
import {
  normalizeNullableSentinel,
  validateHeaders
} from '../lib/import/header-validation.js'

describe('replaceable local providers', () => {
  it('uses Argon2id and never returns a plaintext password hash', async () => {
    const provider = new LocalAuthenticationProvider({} as Service)
    const password = 'synthetic-temporary-password'
    const hash = await provider.hashPassword(password)

    expect(hash).toMatch(/^\$argon2id\$/)
    expect(hash).not.toContain(password)
    await expect(provider.verifyPassword(hash, password)).resolves.toBe(true)
    await expect(provider.verifyPassword(hash, 'wrong-password')).resolves.toBe(false)
  })

  it('resolves only the session active role and does not union assigned roles', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        ID: 'session-1',
        user_ID: 'user-1',
        activeRole: 'ORGANIZATION',
        idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        revokedAt: null
      })
      .mockResolvedValueOnce({ ID: 'user-1', isActive: true })
      .mockResolvedValueOnce({ ID: 'role-organization' })
    const provider = new LocalAuthenticationProvider({ run } as unknown as Service)

    const principal = await provider.resolveSessionToken('x'.repeat(43))
    expect(principal).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
      activeRole: 'ORGANIZATION'
    })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('returns only an activated, explicitly routed annual snapshot', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce([{ ID: 'batch-1', snapshotYear: 2026 }])
      .mockResolvedValueOnce({
        ID: 'snapshot-1',
        employee_ID: 'employee-1',
        snapshotYear: 2026,
        personnelNumber: 'SYNTH-001',
        employeeName: 'Synthetic Employee',
        subgroup: null,
        routingUnit_ID: 'routing-1',
        sourceRoutingUnit: 'Synthetic Routing Label',
        currentJobTitle: null,
        performanceRating: null,
        qualificationSource1: null,
        qualificationSource2: null,
        qualificationDate: null
      })
    const provider = new LocalEmployeeDataProvider({ run } as unknown as Service)

    const result = await provider.findEligibleEmployee(' SYNTH-001 ', 2026)
    expect(result?.routingUnitId).toBe('routing-1')
    expect(result?.personnelNumber).toBe('SYNTH-001')
  })
})

describe('annual workbook validation primitives', () => {
  it('matches required headers by exact trimmed name and rejects duplicates', () => {
    const required = ['رقم الموظف', 'اسم الموظف']
    expect(validateHeaders([' رقم الموظف ', 'اسم الموظف'], required)).toMatchObject({
      valid: true,
      missing: [],
      duplicates: []
    })
    expect(validateHeaders(['رقم الموظف', 'رقم الموظف'], required)).toMatchObject({
      valid: false,
      missing: ['اسم الموظف'],
      duplicates: ['رقم الموظف']
    })
  })

  it('normalizes only blank/whitespace and the literal trimmed 10 sentinel', () => {
    expect(normalizeNullableSentinel(null)).toBeNull()
    expect(normalizeNullableSentinel('   ')).toBeNull()
    expect(normalizeNullableSentinel(' 10 ')).toBeNull()
    expect(normalizeNullableSentinel('جيد')).toBe('جيد')
  })
})

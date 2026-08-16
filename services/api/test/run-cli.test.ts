import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/shared/run-cli.js'
import { githubTokenPattern } from '../scripts/security-patterns.mjs'

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe('CLI lifecycle and secret-pattern regressions', () => {
  it('awaits cleanup after successful CLI work without changing the exit code', async () => {
    const events: string[] = []
    await runCli(async () => { events.push('main') }, async () => { events.push('cleanup') }, 'failed')
    expect(events).toEqual(['main', 'cleanup'])
    expect(process.exitCode).toBe(originalExitCode)
  })

  it('sets a failing exit code, emits a safe message, and still awaits cleanup', async () => {
    const cleanup = vi.fn(async () => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runCli(async () => { throw new Error('synthetic failure') }, cleanup, 'fallback')
    expect(process.exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith('synthetic failure')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('converts cleanup failure into a controlled non-zero exit', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runCli(async () => undefined, async () => { throw new Error('cleanup failed') }, 'fallback')
    expect(process.exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith('cleanup failed')
  })

  it('keeps the concise GitHub-token class strictly ASCII-equivalent', () => {
    expect(githubTokenPattern.test(`ghp_${'A_9'.repeat(10)}`)).toBe(true)
    expect(githubTokenPattern.test(`ghp_${'é'.repeat(30)}`)).toBe(false)
  })
})

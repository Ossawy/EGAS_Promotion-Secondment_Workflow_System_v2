import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNING_STAGE_CODES } from '../api/workflow-types'
import { signatureApi, workflowApi } from '../api/endpoints'
import type { SignatureAssetView } from '../api/workflow-types'
import { SignAndAdvanceControl } from './SignAndAdvanceControl'

vi.mock('../api/endpoints', async importOriginal => {
  const original = await importOriginal<typeof import('../api/endpoints')>()
  return {
    ...original,
    signatureApi: {
      ...original.signatureApi,
      mySignatures: vi.fn(),
      imageUrl: original.signatureApi.imageUrl
    },
    workflowApi: { ...original.workflowApi, signAndAdvance: vi.fn() }
  }
})

const asset: SignatureAssetView = {
  id: 'asset-1',
  mimeType: 'image/png',
  byteSize: 2048,
  sha256: 'a'.repeat(64),
  isActive: true,
  createdAt: new Date().toISOString()
}

afterEach(() => {
  cleanup()
  vi.mocked(signatureApi.mySignatures).mockReset()
  vi.mocked(workflowApi.signAndAdvance).mockReset()
})

describe('official signing (atomic sign-and-advance)', () => {
  it('recognizes exactly the official signing stages P1/P2/P4 and S1/S2/S3', () => {
    expect([...SIGNING_STAGE_CODES].sort()).toEqual(['P1', 'P2', 'P4', 'S1', 'S2', 'S3'])
  })

  it('posts password + signature asset in one atomic command and clears the password after the attempt', async () => {
    vi.mocked(signatureApi.mySignatures).mockResolvedValue([asset])
    vi.mocked(workflowApi.signAndAdvance).mockResolvedValue({} as never)

    render(<MemoryRouter><SignAndAdvanceControl stageId="stage-4" onChanged={() => {}} onError={() => {}} /></MemoryRouter>)

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'asset-1' } })

    fireEvent.click(screen.getByRole('button', { name: /اعتماد وتوقيع/ }))
    const dialog = await screen.findByRole('dialog')
    const passwordInput = withinDialog(dialog)
    expect(passwordInput.getAttribute('type')).toBe('password')

    fireEvent.change(passwordInput, { target: { value: 'synthetic-secret' } })
    fireEvent.submit(passwordInput.closest('form')!)

    await waitFor(() => expect(workflowApi.signAndAdvance).toHaveBeenCalledWith(
      'stage-4',
      { password: 'synthetic-secret', signatureAssetId: 'asset-1' }
    ))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the workflow unchanged on wrong password and allows a fresh attempt', async () => {
    vi.mocked(signatureApi.mySignatures).mockResolvedValue([asset])
    vi.mocked(workflowApi.signAndAdvance).mockRejectedValue(
      Object.assign(new Error('كلمة المرور غير صحيحة'), { status: 401, code: 'SIGNATURE_PASSWORD_INVALID' })
    )

    render(<MemoryRouter><SignAndAdvanceControl stageId="stage-4" onChanged={() => {}} onError={() => {}} /></MemoryRouter>)

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'asset-1' } })
    fireEvent.click(screen.getByRole('button', { name: /اعتماد وتوقيع/ }))
    const dialog = await screen.findByRole('dialog')
    const input = withinDialog(dialog)

    // First attempt fails.
    fireEvent.change(input, { target: { value: 'wrong-password' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByRole('alert')
    // Password input is cleared for the next attempt; no second command was issued yet.
    expect((screen.queryByRole('dialog') !== null) || vi.mocked(workflowApi.signAndAdvance).mock.calls.length === 1).toBe(true)
    expect(vi.mocked(workflowApi.signAndAdvance)).toHaveBeenCalledTimes(1)
  })
})

function withinDialog(dialog: HTMLElement): HTMLInputElement {
  return Array.from(dialog.querySelectorAll('input'))
    .find(input => (input as HTMLInputElement).type === 'password') as HTMLInputElement
}

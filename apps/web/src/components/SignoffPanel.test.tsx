import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

import {
  ApiError,
  apiJson,
  apiRequest
} from '../api/client'
import type {
  WorkflowRequestDetail
} from '../api/workflow-types'
import { useAuth } from '../auth/AuthProvider'
import { SignoffPanel } from './SignoffPanel'

vi.mock('../api/client', async importOriginal => {
  const original =
    await importOriginal<
      typeof import('../api/client')
    >()

  return {
    ...original,
    apiJson: vi.fn(),
    apiRequest: vi.fn()
  }
})

vi.mock(
  '../auth/AuthProvider',
  () => ({
    useAuth: vi.fn()
  })
)

const detail = {
  id: 'request-1',
  requestNumber: 'request-1',
  requestType: 'PROMOTION',
  cycleYear: 2026,
  formMonth: 8,
  formYear: 2026,
  status: 'DRAFT',
  currentStage: 'P1',
  currentIterationNo: 1,
  routingUnit: null,
  approvingAuthority: null,

  createdBy: {
    id: 'ea-1',
    username: 'ea',
    displayName: 'شئون العاملين'
  },

  candidateCount: 0,

  createdAt:
    '2026-08-16T10:00:00.000Z',

  updatedAt:
    '2026-08-16T10:00:00.000Z',

  version: 1,
  editable: true,
  actionable: true,
  candidates: []
} satisfies WorkflowRequestDetail

const asset = {
  id: 'asset-1',
  mimeType: 'image/png' as const,
  fileSizeBytes: 10,
  widthPx: 10,
  heightPx: 5,
  fileSha256: 'a'.repeat(64),
  uploadedAt:
    '2026-08-16T10:00:00.000Z'
}

const signoff = {
  id: 'signoff-1',
  stageCode: 'P1',
  iterationNo: 1,
  signerUserId: 'ea-1',
  signerRole: 'EMPLOYEE_AFFAIRS',
  signerName: 'الموقّع الرسمي',
  signerJobTitle:
    'باحث شئون عاملين',
  jobTitleWasOverridden: false,
  signatureAssetId: 'asset-1',
  signatureSha256:
    'a'.repeat(64),
  signedAt:
    '2026-08-16T10:05:00.000Z'
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
  vi.mocked(apiJson).mockReset()

  vi.mocked(useAuth).mockReturnValue({
    user: {
      userId: 'ea-1',
      username: 'ea',
      staffIdentifier: '1',
      displayName: 'الموقّع الرسمي',
      jobTitle: 'باحث شئون عاملين',
      mustChangePassword: false,
      isActive: true,
      activeRole: 'EMPLOYEE_AFFAIRS',
      availableRoles: [
        {
          role: 'EMPLOYEE_AFFAIRS',
          canManageAdmins: false
        }
      ]
    }
  } as ReturnType<typeof useAuth>)

  Object.defineProperty(
    URL,
    'createObjectURL',
    {
      configurable: true,
      value:
        vi.fn(
          () => 'blob:preview'
        )
    }
  )

  Object.defineProperty(
    URL,
    'revokeObjectURL',
    {
      configurable: true,
      value: vi.fn()
    }
  )

  vi.stubGlobal(
    'requestAnimationFrame',
    (
      callback: FrameRequestCallback
    ) => {
      callback(0)
      return 1
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderPanel(
  changed =
    vi.fn().mockResolvedValue(
      undefined
    )
): Promise<typeof changed> {
  /*
   * Initial GET for existing signoffs.
   */
  vi.mocked(apiRequest)
    .mockResolvedValueOnce([])

  render(
    <SignoffPanel
      detail={detail}
      onChanged={changed}
    />
  )

  expect(
    await screen.findByDisplayValue(
      'باحث شئون عاملين'
    )
  ).toBeInTheDocument()

  /*
   * Forget the initial signoff-list GET,
   * so the test can inspect only actions
   * caused by the user.
   */
  vi.mocked(apiRequest).mockClear()
  vi.mocked(apiJson).mockClear()

  return changed
}

function selectSignatureFile(): File {
  const file =
    new File(
      [
        new Uint8Array(
          [137, 80, 78, 71]
        )
      ],
      'signature.png',
      {
        type: 'image/png'
      }
    )

  fireEvent.change(
    screen.getByLabelText(
      /اختر صورة التوقيع/
    ),
    {
      target: {
        files: [file]
      }
    }
  )

  return file
}

function openPasswordDialog(): void {
  selectSignatureFile()

  fireEvent.click(
    screen.getByRole(
      'button',
      {
        name:
          'اعتماد توقيع المرحلة'
      }
    )
  )
}

describe(
  'mandatory signoff password reauthentication',
  () => {
    it(
      'opens the password dialog without uploading or signing',
      async () => {
        await renderPanel()

        openPasswordDialog()

        expect(
          screen.getByRole(
            'dialog',
            {
              name:
                'تأكيد الهوية قبل التوقيع'
            }
          )
        ).toBeInTheDocument()

        expect(
          screen.getByLabelText(
            'كلمة المرور'
          )
        ).toBeInTheDocument()

        /*
         * Clicking the original sign button
         * must now perform NO network action.
         */
        expect(
          apiRequest
        ).not.toHaveBeenCalled()

        expect(
          apiJson
        ).not.toHaveBeenCalled()
      }
    )

    it(
      'cancels without uploading or signing and clears the password',
      async () => {
        await renderPanel()

        openPasswordDialog()

        const passwordInput =
          screen.getByLabelText(
            'كلمة المرور'
          )

        fireEvent.change(
          passwordInput,
          {
            target: {
              value:
                'password-to-clear'
            }
          }
        )

        expect(
          passwordInput
        ).toHaveValue(
          'password-to-clear'
        )

        fireEvent.click(
          screen.getByRole(
            'button',
            {
              name: 'إلغاء'
            }
          )
        )

        expect(
          screen.queryByRole(
            'dialog'
          )
        ).not.toBeInTheDocument()

        expect(
          apiRequest
        ).not.toHaveBeenCalled()

        expect(
          apiJson
        ).not.toHaveBeenCalled()

        /*
         * Reopen the dialog to prove that
         * the previous password was removed.
         */
        fireEvent.click(
          screen.getByRole(
            'button',
            {
              name:
                'اعتماد توقيع المرحلة'
            }
          )
        )

        expect(
          screen.getByLabelText(
            'كلمة المرور'
          )
        ).toHaveValue('')
      }
    )

    it(
      'uploads and sends the exact password only after confirmation',
      async () => {
        const file =
          new File(
            [
              new Uint8Array(
                [137, 80, 78, 71]
              )
            ],
            'signature.png',
            {
              type: 'image/png'
            }
          )

        const changed =
          await renderPanel()

        fireEvent.change(
          screen.getByLabelText(
            /اختر صورة التوقيع/
          ),
          {
            target: {
              files: [file]
            }
          }
        )

        fireEvent.click(
          screen.getByRole(
            'button',
            {
              name:
                'اعتماد توقيع المرحلة'
            }
          )
        )

        /*
         * Still nothing has been sent.
         */
        expect(
          apiRequest
        ).not.toHaveBeenCalled()

        expect(
          apiJson
        ).not.toHaveBeenCalled()

        const exactPassword =
          '  exact current password  '

        fireEvent.change(
          screen.getByLabelText(
            'كلمة المرور'
          ),
          {
            target: {
              value:
                exactPassword
            }
          }
        )

        /*
         * Upload result, followed by the
         * signoff-list reload on success.
         */
        vi.mocked(apiRequest)
          .mockResolvedValueOnce(asset)
          .mockResolvedValueOnce([])

        vi.mocked(apiJson)
          .mockResolvedValue(
            signoff
          )

        fireEvent.click(
          screen.getByRole(
            'button',
            {
              name:
                'تأكيد والتوقيع'
            }
          )
        )

        await waitFor(
          () =>
            expect(
              apiRequest
            ).toHaveBeenCalledWith(
              '/api/workflow/signatures',
              expect.objectContaining({
                method: 'POST',
                body: file,
                headers: {
                  'Content-Type':
                    'image/png'
                }
              })
            )
        )

        await waitFor(
          () =>
            expect(
              apiJson
            ).toHaveBeenCalledWith(
              '/api/workflow/requests/request-1/signoff',
              'POST',
              {
                signatureAssetId:
                  'asset-1',

                jobTitle:
                  'باحث شئون عاملين',

                /*
                 * Intentionally contains
                 * leading/trailing spaces.
                 */
                password:
                  exactPassword
              }
            )
        )

        await waitFor(
          () =>
            expect(
              changed
            ).toHaveBeenCalledTimes(1)
        )

        expect(
          screen.queryByRole(
            'dialog'
          )
        ).not.toBeInTheDocument()
      }
    )

    it(
      'shows the Arabic wrong-password error and clears the password field',
      async () => {
        await renderPanel()

        openPasswordDialog()

        vi.mocked(apiRequest)
          .mockResolvedValueOnce(asset)

        vi.mocked(apiJson)
          .mockRejectedValueOnce(
            new ApiError(
              401,
              'SIGNATURE_PASSWORD_INVALID',
              'Signature password is incorrect'
            )
          )

        fireEvent.change(
          screen.getByLabelText(
            'كلمة المرور'
          ),
          {
            target: {
              value:
                'wrong-password'
            }
          }
        )

        fireEvent.click(
          screen.getByRole(
            'button',
            {
              name:
                'تأكيد والتوقيع'
            }
          )
        )

        expect(
          await screen.findByText(
            'كلمة المرور غير صحيحة. لم يتم اعتماد التوقيع.'
          )
        ).toBeInTheDocument()

        /*
         * Dialog remains open for retry.
         */
        expect(
          screen.getByRole(
            'dialog',
            {
              name:
                'تأكيد الهوية قبل التوقيع'
            }
          )
        ).toBeInTheDocument()

        /*
         * But the rejected credential is
         * no longer retained in state.
         */
        expect(
          screen.getByLabelText(
            'كلمة المرور'
          )
        ).toHaveValue('')

        expect(
          apiJson
        ).toHaveBeenCalledTimes(1)
      }
    )

    it(
      'prevents duplicate confirmation while the first attempt is pending',
      async () => {
        await renderPanel()

        openPasswordDialog()

        let resolveUpload:
          (
            value: typeof asset
          ) => void =
            () => undefined

        const pendingUpload =
          new Promise<
            typeof asset
          >(
            resolve => {
              resolveUpload =
                resolve
            }
          )

        vi.mocked(apiRequest)
          .mockImplementationOnce(
            async () =>
              await pendingUpload
          )
          .mockResolvedValueOnce([])

        vi.mocked(apiJson)
          .mockResolvedValue(
            signoff
          )

        fireEvent.change(
          screen.getByLabelText(
            'كلمة المرور'
          ),
          {
            target: {
              value:
                'single-use-password'
            }
          }
        )

        const confirmButton =
          screen.getByRole(
            'button',
            {
              name:
                'تأكيد والتوقيع'
            }
          )

        fireEvent.click(
          confirmButton
        )

        fireEvent.click(
          confirmButton
        )

        await waitFor(
          () =>
            expect(
              apiRequest
            ).toHaveBeenCalledTimes(1)
        )

        /*
         * Signoff cannot begin until
         * the single upload completes.
         */
        expect(
          apiJson
        ).not.toHaveBeenCalled()

        resolveUpload(asset)

        await waitFor(
          () =>
            expect(
              apiJson
            ).toHaveBeenCalledTimes(1)
        )

        /*
         * One upload + one later reload.
         * No duplicate upload occurred.
         */
        await waitFor(
          () =>
            expect(
              apiRequest
            ).toHaveBeenCalledTimes(2)
        )

        expect(
          apiJson
        ).toHaveBeenCalledTimes(1)
      }
    )
  }
)
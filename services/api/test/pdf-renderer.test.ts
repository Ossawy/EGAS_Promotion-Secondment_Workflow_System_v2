import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type {
  FormSnapshot
} from '../src/modules/workflow/form-snapshot.ts'

import {
  OfficialPdfV2Canvas,
  renderOfficialPdfV2
} from '../src/modules/workflow/pdf-renderer.ts'

function baseSnapshot(
  requestType: 'PROMOTION' | 'SECONDMENT'
): FormSnapshot {
  return {
    schemaVersion: 1,

    kind: 'DRAFT',

    capturedAt:
      '2026-08-18T08:00:00.000Z',

    task: null,

    request: {
      id: 'test-request',

      requestNumber:
        'EGAS-TEST-001',

      requestType,

      routingUnitName:
        'الشئون الإدارية والموارد البشرية',

      formMonth: 8,

      formYear: 2026,

      cycleYear: 2026,

      currentStage:
        requestType === 'PROMOTION'
          ? 'P4'
          : 'S3',

      status: 'DRAFT'
    },

    candidates: [],

    signoffs: [],

    approvals: [],

    requestNotes: []
  }
}

function promotionSnapshot(): FormSnapshot {
  const snapshot =
    baseSnapshot('PROMOTION')

  snapshot.candidates =
    Array.from(
      { length: 11 },
      (_, index) => {
        const managerCategory =
          index < 7

        const samePosition =
          index % 2 === 0

        return {
          id:
            `candidate-${index + 1}`,

          personnelNumber:
            String(
              10000 + index
            ),

          employeeName:
            managerCategory
              ? `مرشح تجريبي مدير ${index + 1}`
              : `مرشح تجريبي رئيس قسم ${index - 6}`,

          currentJobTitle:
            managerCategory
              ? 'مدير إدارة متابعة وتطوير الأعمال والشئون التنظيمية'
              : 'رئيس قسم متابعة شئون العاملين والتطوير الإداري',

          subgroup:
            'مجموعة الوظائف الإدارية',

          performanceRating:
            'ممتاز',

          qualificationSource1:
            'بكالوريوس تجارة',

          qualificationSource2:
            'جامعة القاهرة',

          qualificationDate:
            '2012-06-30',

          lastPromotionReport:
            index % 3 === 0
              ? 'ممتاز - مستوفى'
              : 'جيد جداً - مستوفى',

          displayOrder:
            index + 1,

          jobCategoryCode:
            managerCategory
              ? 'MANAGER'
              : 'SECTION_HEAD',

          jobCategoryName:
            managerCategory
              ? 'مدير إدارة'
              : 'رئيس قسم',

          positions: [],

          promotionDecision:
            samePosition
              ? {
                  candidateId:
                    `candidate-${index + 1}`,

                  decisionType:
                    'SAME_POSITION',

                  targetJobTitle:
                    null,

                  targetRoutingUnitName:
                    null,

                  notes:
                    null
                }
              : {
                  candidateId:
                    `candidate-${index + 1}`,

                  decisionType:
                    'OTHER_POSITION',

                  targetJobTitle:
                    'مدير إدارة التخطيط والمتابعة وتطوير نظم العمل',

                  targetRoutingUnitName:
                    'نيابة الشئون الإدارية والموارد البشرية',

                  notes:
                    'تم اختيار الوظيفة وفقاً للاحتياج التنظيمي'
                },

          notes:
            index === 2
              ? [
                  {
                    message:
                      'ملاحظة تجريبية طويلة لاختبار التفاف النص داخل خلية الملاحظات والتأكد من عدم تداخل النص مع حدود الجدول أو الخلايا المجاورة.'
                  }
                ]
              : index === 8
                ? [
                    {
                      message:
                        'يراعى استكمال الإجراءات التنظيمية المطلوبة قبل صدور القرار النهائي.'
                    }
                  ]
                : []
        }
      }
    )

  snapshot.signoffs = [
    {
      id: 'signoff-p1',

      stageCode: 'P1',

      signerName:
        'أحمد محمد علي',

      signerJobTitle:
        'مدير عام شئون العاملين',

      signatureAssetId:
        'test-signature-p1',

      signatureSha256:
        'preview-only',

      signedAt:
        '2026-08-18T08:30:00.000Z'
    },

    {
      id: 'signoff-p2',

      stageCode: 'P2',

      signerName:
        'محمود أحمد إبراهيم',

      signerJobTitle:
        'مدير عام إدارة التنظيم',

      signatureAssetId:
        'test-signature-p2',

      signatureSha256:
        'preview-only',

      signedAt:
        '2026-08-18T09:00:00.000Z'
    }
  ]

  return snapshot
}

function secondmentSnapshot(): FormSnapshot {
  const snapshot =
    baseSnapshot('SECONDMENT')

  snapshot.candidates = [
    {
      id: 'secondment-candidate-1',
      personnelNumber: '20001',
      employeeName: 'مرشح ندب أول',
      currentJobTitle:
        'رئيس قسم متابعة شئون العاملين والتطوير الإداري',
      subgroup:
        'مجموعة الوظائف الإدارية',
      performanceRating: 'ممتاز',
      qualificationSource1:
        'بكالوريوس تجارة',
      qualificationSource2:
        'جامعة القاهرة',
      qualificationDate:
        '2014-06-30',
      lastPromotionReport:
        'ممتاز - مستوفى',
      displayOrder: 1,
      jobCategoryCode:
        'SECTION_HEAD',
      jobCategoryName:
        'رئيس قسم',

      promotionDecision: null,

      notes: [
        {
          message:
            'ملاحظة تجريبية لاختبار ظهور ملاحظات المرشح داخل الخلية المدمجة.'
        }
      ],

      positions: [
        {
          id: 'position-1',
          positionTitle:
            'رئيس قسم التخطيط والمتابعة',
          organizationalDependency:
            'إدارة التخطيط والمتابعة',
          qualificationStatus:
            'QUALIFIED',
          isSelected: false,
          displayOrder: 1
        },
        {
          id: 'position-2',
          positionTitle:
            'رئيس قسم تطوير نظم العمل',
          organizationalDependency:
            'الإدارة العامة للتنظيم',
          qualificationStatus:
            'NOT_QUALIFIED',
          isSelected: false,
          displayOrder: 2
        },
        {
          id: 'position-3',
          positionTitle:
            'رئيس قسم الموارد البشرية',
          organizationalDependency:
            'نيابة الشئون الإدارية والموارد البشرية',
          qualificationStatus:
            'QUALIFIED',
          isSelected: true,
          displayOrder: 3
        }
      ]
    },

    {
      id: 'secondment-candidate-2',
      personnelNumber: '20002',
      employeeName: 'مرشح ندب ثان',
      currentJobTitle:
        'أخصائي أول شئون إدارية',
      subgroup:
        'مجموعة الوظائف الإدارية',
      performanceRating:
        'جيد جداً',
      qualificationSource1:
        'ليسانس حقوق',
      qualificationSource2:
        'جامعة عين شمس',
      qualificationDate:
        '2015-07-15',
      lastPromotionReport:
        'جيد جداً - مستوفى',
      displayOrder: 2,
      jobCategoryCode:
        'SECTION_HEAD',
      jobCategoryName:
        'رئيس قسم',
      promotionDecision: null,
      notes: [],
      positions: [
        {
          id: 'position-4',
          positionTitle:
            'رئيس قسم الشئون الإدارية',
          organizationalDependency:
            'الإدارة العامة للشئون الإدارية',
          qualificationStatus:
            'QUALIFIED',
          isSelected: true,
          displayOrder: 1
        }
      ]
    },

    {
      id: 'secondment-candidate-3',
      personnelNumber: '20003',
      employeeName:
        'مرشح ندب مدير إدارة',
      currentJobTitle:
        'مدير إدارة المتابعة والتطوير',
      subgroup:
        'مجموعة الوظائف الإدارية',
      performanceRating:
        'ممتاز',
      qualificationSource1:
        'بكالوريوس إدارة أعمال',
      qualificationSource2:
        'جامعة القاهرة',
      qualificationDate:
        '2010-06-20',
      lastPromotionReport:
        'ممتاز - مستوفى',
      displayOrder: 3,
      jobCategoryCode:
        'MANAGER',
      jobCategoryName:
        'مدير إدارة',
      promotionDecision: null,
      notes: [],
      positions: [
        {
          id: 'position-5',
          positionTitle:
            'مدير إدارة التطوير المؤسسي',
          organizationalDependency:
            'الإدارة العامة للتنظيم',
          qualificationStatus:
            'QUALIFIED',
          isSelected: true,
          displayOrder: 1
        }
      ]
    }
  ]

  snapshot.signoffs = [
    {
      id: 'signoff-s1',
      stageCode: 'S1',
      signerName:
        'أحمد محمد علي',
      signerJobTitle:
        'مدير عام شئون العاملين',
      signatureAssetId:
        'test-signature-s1',
      signatureSha256:
        'preview-only',
      signedAt:
        '2026-08-18T08:30:00.000Z'
    },

    {
      id: 'signoff-s2',
      stageCode: 'S2',
      signerName:
        'محمود أحمد إبراهيم',
      signerJobTitle:
        'مدير عام إدارة التنظيم',
      signatureAssetId:
        'test-signature-s2',
      signatureSha256:
        'preview-only',
      signedAt:
        '2026-08-18T09:00:00.000Z'
    }
  ]

  return snapshot
}

function pageCount(
  pdf: Buffer
): number {
  const source =
    pdf.toString('latin1')

  return (
    source.match(
      /\/Type\s*\/Page\b/g
    ) ?? []
  ).length
}

describe(
  'Official PDF V2 renderer',
  () => {
    it(
      'uses A4 landscape and renders the EGAS letterhead',
      async () => {
        const canvas =
          new OfficialPdfV2Canvas(
            5_000_000,
            'اختبار النموذج الرسمي',
            'أغسطس 2026'
          )

        expect(
          canvas.doc.page.width
        ).toBeGreaterThan(
          canvas.doc.page.height
        )

        const pdf =
          await canvas.finish()

        expect(
          pdf
            .subarray(0, 5)
            .toString()
        ).toBe('%PDF-')
      }
    )

    it(
      'renders Promotion and Secondment V2 entry points',
      async () => {
        const images =
          new Map<string, Buffer>()

        const promotion =
          await renderOfficialPdfV2(
            baseSnapshot(
              'PROMOTION'
            ),
            images,
            5_000_000
          )

        const secondment =
          await renderOfficialPdfV2(
            baseSnapshot(
              'SECONDMENT'
            ),
            images,
            5_000_000
          )

        expect(
          promotion
            .subarray(0, 5)
            .toString()
        ).toBe('%PDF-')

        expect(
          secondment
            .subarray(0, 5)
            .toString()
        ).toBe('%PDF-')

        expect(
          promotion.length
        ).toBeGreaterThan(1_000)

        expect(
          secondment.length
        ).toBeGreaterThan(1_000)
      }
    )

    it(
      'renders realistic Promotion rows, pagination, categories, decisions and signoffs',
      async () => {
        /*
         * The EGAS logo is deliberately
         * reused as a mock signature image
         * for this renderer-only test.
         *
         * Production still supplies the real
         * verified signature evidence.
         */
        const mockSignature =
          await readFile(
            new URL(
              '../src/assets/egas-logo.png',
              import.meta.url
            )
          )

        const images =
          new Map<string, Buffer>([
            [
              'test-signature-p1',
              mockSignature
            ],

            [
              'test-signature-p2',
              mockSignature
            ]
          ])

        const pdf =
          await renderOfficialPdfV2(
            promotionSnapshot(),
            images,
            5_000_000
          )

        expect(
          pdf
            .subarray(0, 5)
            .toString()
        ).toBe('%PDF-')

        /*
         * The fixture is intentionally
         * large enough to exercise
         * continuation-page behavior.
         */
        expect(
          pageCount(pdf)
        ).toBeGreaterThan(1)

        /*
         * Preview generation is opt-in so
         * normal automated test runs never
         * write files.
         */
        if (
          process.env
            .EGAS_PDF_PREVIEW ===
          '1'
        ) {
          const previewPath =
            join(
              tmpdir(),
              'EGAS-Promotion-V2-preview.pdf'
            )

          await writeFile(
            previewPath,
            pdf
          )

          console.log(
            `Promotion V2 preview: ${previewPath}`
          )
        }
      }
        )

    it(
      'renders realistic Secondment merged vacancy rows and signoffs',
      async () => {
        const mockSignature =
          await readFile(
            new URL(
              '../src/assets/egas-logo.png',
              import.meta.url
            )
          )

        const images =
          new Map<string, Buffer>([
            [
              'test-signature-s1',
              mockSignature
            ],
            [
              'test-signature-s2',
              mockSignature
            ]
          ])

        const pdf =
          await renderOfficialPdfV2(
            secondmentSnapshot(),
            images,
            5_000_000
          )

        expect(
          pdf
            .subarray(0, 5)
            .toString()
        ).toBe('%PDF-')

        expect(
          pdf.length
        ).toBeGreaterThan(
          1_000
        )

        if (
          process.env
            .EGAS_SECONDMENT_PDF_PREVIEW ===
          '1'
        ) {
          const previewPath =
            join(
              tmpdir(),
              'EGAS-Secondment-V2-preview.pdf'
            )

          await writeFile(
            previewPath,
            pdf
          )

          console.log(
            `Secondment V2 preview: ${previewPath}`
          )
        }
      }
    )
  }
)
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { renderOfficialFormPdf } from '../dist/modules/workflow/pdf-renderer.js'

const outputDirectory = resolve('tmp/pdf-visual-check')
const maxOutputBytes = 20_971_520

const signatureAssetIds = {
  hr: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  auth: '33333333-3333-4333-8333-333333333333',
}

const signaturePlaceholder = await sharp({
  create: {
    width: 180,
    height: 72,
    channels: 4,
    background: { r: 10, g: 95, b: 62, alpha: 1 },
  },
})
  .png()
  .toBuffer()

const signatureImages = new Map(
  Object.values(signatureAssetIds).map((signatureAssetId) => [signatureAssetId, signaturePlaceholder]),
)

function candidate(index, overrides = {}) {
  return {
    candidateId: `candidate-${index}`,
    personnelNumber: `EGAS-${String(index).padStart(5, '0')}`,
    employeeName: `المهندس أحمد محمد عبد الرحمن السيد محمود رقم ${index}`,
    currentJobTitle: 'مهندس أول تخطيط المشروعات والتحول الرقمي',
    currentJobStartDate: '2017-09-01',
    sourceRoutingLabel: 'نيابة مساعد الرئيس التنفيذي للمشروعات والتحول الرقمي',
    subgroup: 'الإدارة العامة للتخطيط والمتابعة',
    department: 'الإدارة العامة لتخطيط المشروعات والتحول الرقمي',
    seniorityDate: '2012-03-15',
    joiningDate: '2009-11-01',
    experienceStartDate: '2008-07-01',
    qualificationDate: '2008-06-30',
    qualificationName: 'بكالوريوس هندسة - شعبة القوى والآلات الكهربية',
    qualificationInstitute: 'كلية الهندسة، جامعة القاهرة',
    performanceRating: 'ممتاز',
    lastPromotionReport: 'ممتاز وفق تقرير الكفاية السنوي المعتمد',
    experience: {
      years: 17,
      months: 8,
      days: index,
      referenceDate: '2026-01-01',
    },
    ...overrides,
  }
}

function signoff(stageCode, executionNo, signerName, signerJobTitle, operationalUnitKind, signatureAssetId) {
  return {
    stageCode,
    stageExecutionId: `${stageCode.toLowerCase()}-execution-${executionNo}`,
    executionNo,
    signerUserId: `${stageCode.toLowerCase()}-manager`,
    signerName,
    signerUsername: `${stageCode.toLowerCase()}-manager`,
    signerJobTitle,
    jobTitleWasOverridden: false,
    operationalUnitId: `${operationalUnitKind.toLowerCase()}-unit`,
    operationalUnitKind,
    managerAssignmentId: `${stageCode.toLowerCase()}-assignment`,
    signatureAssetId,
    signatureSha256: `${stageCode}-visual-check-signature-sha256`,
    signedAt: '2026-08-21T10:30:00.000Z',
  }
}

const promotionSnapshot = {
  schemaVersion: 1,
  kind: 'FINAL',
  templateVersion: 'EGAS-OFFICIAL-PROMOTION-AR-3.0',
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestNumber: 'VISUAL-PROMOTION-2026-001',
  requestType: 'PROMOTION',
  routingUnit: {
    id: '44444444-4444-4444-8444-444444444444',
    code: 'VISUAL-RU',
    nameAr: 'نيابة مساعد الرئيس التنفيذي للمشروعات والتحول الرقمي',
  },
  iterationId: '55555555-5555-4555-8555-555555555555',
  iterationNo: 1,
  cycleYear: 2026,
  capturedAt: '2026-08-21T10:45:00.000Z',
  candidates: Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 1
    const otherPosition = index % 2 === 0
    return candidate(index, {
      subgroup: index <= 4 ? 'وظيفة مدير إدارة' : 'وظيفة مدير عام',
      promotionDecision: {
        decisionType: otherPosition ? 'OTHER_POSITION' : 'SAME_POSITION',
        targetJobTitle: otherPosition
          ? 'رئيس قسم تخطيط المشروعات الرأسمالية'
          : null,
        effectiveNominatedJob: otherPosition
          ? 'رئيس قسم تخطيط المشروعات الرأسمالية'
          : 'مهندس خبير تخطيط المشروعات والتحول الرقمي',
        recommendation: otherPosition ? 'تأجيل' : 'ترشيح',
        notes:
          'ملاحظة اختبار مرئي للتأكد من التفاف النص العربي داخل خلايا الجدول دون قص.',
      },
    })
  }),
  signoffs: [
    signoff('P1', 1, 'د. سارة أحمد علي', 'مدير عام الموارد البشرية', 'HR', signatureAssetIds.hr),
    signoff('P2', 1, 'م. خالد محمود حسن', 'مدير عام التنظيم وتطوير الأعمال', 'ORG', signatureAssetIds.org),
    signoff('P4', 1, 'م. نادر إبراهيم يوسف', 'مدير نيابة مساعد الرئيس التنفيذي للمشروعات', 'AUTH', signatureAssetIds.auth),
  ],
}

const secondmentSnapshot = {
  schemaVersion: 1,
  kind: 'FINAL',
  templateVersion: 'EGAS-OFFICIAL-SECONDMENT-AR-BASELINE-1.0',
  requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestNumber: 'VISUAL-SECONDMENT-2026-001',
  requestType: 'SECONDMENT',
  routingUnit: {
    id: '66666666-6666-4666-8666-666666666666',
    code: 'VISUAL-RU',
    nameAr: 'نيابة مساعد الرئيس التنفيذي للمشروعات والتحول الرقمي',
  },
  iterationId: '77777777-7777-4777-8777-777777777777',
  iterationNo: 1,
  cycleYear: 2026,
  capturedAt: '2026-08-21T11:00:00.000Z',
  candidates: Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 21
    const selectedOptionId = `selected-option-${index}-primary`
    return candidate(index, {
      secondmentPreparation: {
        sourceS2StageExecutionId: 's2-execution-1',
        lastPromotionReport: 'تقرير آخر ترقية معتمد ومجمد ضمن إعدادات التنظيم',
        jobCategoryCode: index <= 24 ? 'MANAGER' : 'SECTION_HEAD',
        jobCategoryName: index <= 24 ? 'وظيفة مدير إدارة :-' : 'وظيفة رئيس قسم :-',
      },
      candidateNotes: index === 21 ? ['ملاحظة مرشح مجمدة لاختبار التفاف النص العربي في عمود الملاحظات.'] : [],
      secondmentPositionOptions: [
        {
          optionId: selectedOptionId,
          sourceS2StageExecutionId: 's2-execution-1',
          positionTitle: 'أخصائي أول متابعة المشروعات الاستراتيجية والتحول الرقمي',
          organizationalDependency: 'الإدارة العامة للمشروعات الرأسمالية والمتابعة التنفيذية',
          qualificationStatus: 'QUALIFIED',
          qualificationStatusName: 'مستوفٍ للمؤهل والخبرة المطلوبة لشغل الوظيفة المقترحة',
          displayOrder: 0,
        },
        ...(index === 21
          ? [{
              optionId: `selected-option-${index}-alternative`,
              sourceS2StageExecutionId: 's2-execution-1',
              positionTitle: 'رئيس قسم تخطيط المبادرات الرأسمالية ومتابعة تنفيذ المشروعات ذات الأولوية',
              organizationalDependency: 'الإدارة العامة المساعدة لتخطيط المشروعات الرأسمالية والتحول الرقمي',
              qualificationStatus: 'QUALIFIED',
              qualificationStatusName: 'مستوفٍ للمؤهل والخبرة المطلوبة لشغل الوظيفة المقترحة',
              displayOrder: 1,
            }]
          : []),
      ],
      secondmentSelection: {
        selectedOptionId,
        positionTitle: 'أخصائي أول متابعة المشروعات الاستراتيجية والتحول الرقمي',
        organizationalDependency: 'الإدارة العامة للمشروعات الرأسمالية والمتابعة التنفيذية',
        qualificationStatus: 'QUALIFIED',
        qualificationStatusName: 'مستوفٍ للمؤهل والخبرة المطلوبة لشغل الوظيفة المقترحة',
      },
    })
  }),
  signoffs: [
    signoff('S1', 1, 'د. سارة أحمد علي', 'مدير عام الموارد البشرية', 'HR', signatureAssetIds.hr),
    signoff('S2', 1, 'م. خالد محمود حسن', 'مدير عام التنظيم وتطوير الأعمال', 'ORG', signatureAssetIds.org),
    signoff('S3', 1, 'م. نادر إبراهيم يوسف', 'مدير نيابة مساعد الرئيس التنفيذي للمشروعات', 'AUTH', signatureAssetIds.auth),
  ],
}

await mkdir(outputDirectory, { recursive: true })

const promotionOutput = resolve(outputDirectory, 'promotion-final-form.pdf')
const secondmentOutput = resolve(outputDirectory, 'secondment-final-form.pdf')

const [promotionPdf, secondmentPdf] = await Promise.all([
  renderOfficialFormPdf(promotionSnapshot, signatureImages, maxOutputBytes),
  renderOfficialFormPdf(secondmentSnapshot, signatureImages, maxOutputBytes),
])

await Promise.all([writeFile(promotionOutput, promotionPdf), writeFile(secondmentOutput, secondmentPdf)])

process.stdout.write(`Visual QA PDFs written to:\n${promotionOutput}\n${secondmentOutput}\n`)

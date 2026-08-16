import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderOfficialPdf } from '../dist/modules/workflow/pdf-renderer.js'

const output = resolve('tmp/pdf-visual-check.pdf')
await mkdir(resolve('tmp'), { recursive: true })
const snapshot = {
  schemaVersion: 1,
  kind: 'FINAL',
  capturedAt: '2026-08-16T12:00:00.000Z',
  task: null,
  request: {
    requestNumber: 'SYNTHETIC-PDF-CHECK', requestType: 'PROMOTION', cycleYear: 2026,
    formMonth: 8, formYear: 2026, status: 'COMPLETED', currentStage: 'P5', iterationNo: 1,
    routingUnitName: 'نظم المعلومات والاتصالات', authorityName: 'نائب الرئيس التنفيذي'
  },
  candidates: [{
    id: 'synthetic-candidate', personnelNumber: '10001', employeeName: 'عامل اختبار بصري',
    currentJobTitle: 'أخصائي نظم معلومات', qualificationSource1: 'بكالوريوس حاسبات ومعلومات',
    qualificationSource2: 'جامعة اختبار', qualificationDate: '2015-06-01', performanceRating: 'ممتاز',
    jobCategoryName: 'الوظائف التخصصية', lastPromotionReport: 'مستوفٍ للضوابط',
    promotionDecision: { decisionType: 'OTHER_POSITION', targetJobTitle: 'كبير أخصائيين', notes: 'قرار اختبار بصري فقط' },
    positions: [], notes: [{ authorName: 'مسؤول شئون العاملين', authorRole: 'EMPLOYEE_AFFAIRS',
      createdAt: '2026-08-16T10:00:00.000Z', message: 'ملاحظة عربية للتأكد من اتجاه النص وتشكيل الحروف.' }]
  }],
  signoffs: [],
  approvals: [{ actionCode: 'PROMOTION_P5_FINAL_APPROVED', actorName: 'مسؤول شئون العاملين',
    actorUsername: 'synthetic-ea', actorRole: 'EMPLOYEE_AFFAIRS', createdAt: '2026-08-16T12:00:00.000Z', reason: null }],
  requestNotes: []
}
await writeFile(output, await renderOfficialPdf(snapshot, new Map(), 20_971_520))
process.stdout.write(output)

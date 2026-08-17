import { createRequire } from 'node:module'
import PDFDocument from 'pdfkit'
import type { FormSnapshot } from './form-snapshot.ts'

export type AuditPdfEntry = {
  requestNumber: string
  candidateName: string | null
  actorName: string | null
  actorUsername: string | null
  actorRole: string | null
  actionCode: string
  fromStage: string | null
  toStage: string | null
  reason: string | null
  createdAt: string
}

const require = createRequire(import.meta.url)
const regularFont = require.resolve('@ibm/plex-sans-arabic/fonts/complete/woff/IBMPlexSansArabic-Regular.woff')
const boldFont = require.resolve('@ibm/plex-sans-arabic/fonts/complete/woff/IBMPlexSansArabic-Bold.woff')
const green = '#075b3b'
const pale = '#eaf4ee'
const ink = '#153329'
const muted = '#5f726b'
const border = '#c9d8d0'

function clean(value: unknown, fallback = '—'): string {
  if (value === undefined || value === null || value === '') return fallback
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 4_000) || fallback
}

// PDFKit's bidi layout can visually compress a single U+0020 between Arabic runs.
// Doubling the ordinary space preserves a readable gap without introducing unsupported glyphs.
function visual(value: unknown, fallback = '—'): string { return clean(value, fallback).replace(/ /g, '  ') }

function arabicDate(value: unknown): string {
  try { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(String(value))) }
  catch { return clean(value) }
}

function stateLabel(kind: FormSnapshot['kind']): string {
  return kind === 'FINAL' ? 'نسخة نهائية معتمدة' : kind === 'RECEIVED' ? 'نسخة الاستلام الثابتة' : 'مسودة عمل'
}

function roleLabel(role: unknown): string {
  const roles: Record<string, string> = { EMPLOYEE_AFFAIRS: 'شئون العاملين', ORGANIZATION: 'التنظيم', APPROVING_AUTHORITY: 'سلطة الاعتماد', ADMIN: 'إدارة النظام' }
  return roles[String(role)] ?? clean(role)
}

function actionLabel(code: unknown): string {
  const actions: Record<string, string> = {
    PROMOTION_P1_SUBMITTED: 'إرسال شئون العاملين', PROMOTION_P2_SUBMITTED: 'إرسال التنظيم',
    PROMOTION_P3_APPROVED: 'مراجعة شئون العاملين', PROMOTION_P4_APPROVED: 'قرار سلطة الاعتماد',
    PROMOTION_P4_SENT_TO_ORGANIZATION: 'إحالة للتنظيم بعد قرار سلطة الاعتماد',
    PROMOTION_P4O_CONFIRMED: 'تأكيد التنظيم بعد قرار سلطة الاعتماد',
    PROMOTION_P5_FINAL_APPROVED: 'اعتماد نهائي', SECONDMENT_S1_SUBMITTED: 'إرسال شئون العاملين',
    SECONDMENT_S2_SUBMITTED: 'إرسال التنظيم', SECONDMENT_S3_APPROVED: 'قرار سلطة الاعتماد',
    SECONDMENT_S4_CONFIRMED: 'تأكيد التنظيم', SECONDMENT_S5_FINAL_APPROVED: 'اعتماد نهائي',
    WORKFLOW_RETURNED_FOR_CORRECTION: 'إرجاع للتصحيح', WORKFLOW_REJECTED: 'رفض',
    WORKFLOW_RESTARTED: 'إعادة بدء', WORKFLOW_RECALLED: 'استدعاء'
  }
  return actions[String(code)] ?? clean(code)
}

class ArabicPdfCanvas {
  readonly doc: PDFKit.PDFDocument
  private y = 92

  constructor(private readonly maxOutputBytes: number, title: string) {
    this.doc = new PDFDocument({ size: 'A4', margins: { top: 88, right: 38, bottom: 44, left: 38 },
      bufferPages: true, compress: true, info: { Title: title, Author: 'EGAS', Creator: 'EGAS Workflow System' } })
    this.doc.registerFont('Arabic', regularFont)
    this.doc.registerFont('ArabicBold', boldFont)
    this.doc.font('Arabic')
    this.header(title)
  }

  private header(title: string): void {
    const pageWidth = this.doc.page.width
    this.doc.save().rect(0, 0, pageWidth, 70).fill(green).restore()
    this.doc.fillColor('#ffffff').font('ArabicBold').fontSize(16)
      .text(visual(title), 38, 18, { width: pageWidth - 76, align: 'right' })
    this.doc.font('Arabic').fontSize(9).text(visual('الهيئة المصرية العامة للبترول والغاز — نظام الترقيات والندب'), 38, 45,
      { width: pageWidth - 76, align: 'right' })
    this.y = 92
  }

  private addPage(title = 'نموذج الطلب الرسمي'): void {
    this.doc.addPage()
    this.header(title)
  }

  ensure(height: number): void {
    if (this.y + height > this.doc.page.height - 52) this.addPage()
  }

  section(title: string): void {
    this.ensure(38)
    const width = this.doc.page.width - 76
    this.doc.save().roundedRect(38, this.y, width, 27, 5).fill(pale).restore()
    this.doc.fillColor(green).font('ArabicBold').fontSize(11).text(visual(title), 48, this.y + 6, { width: width - 20, align: 'right' })
    this.y += 36
  }

  line(label: string, value: unknown, indent = 0): void {
    const width = this.doc.page.width - 76 - indent
    const labelWidth = Math.min(145, width * .32)
    const valueWidth = width - labelWidth - 26
    this.doc.font('Arabic').fontSize(9.5)
    const height = Math.max(24,
      this.doc.heightOfString(visual(value), { width: valueWidth, align: 'right' }) + 9,
      this.doc.heightOfString(visual(label), { width: labelWidth, align: 'right' }) + 9)
    this.ensure(height)
    this.doc.save().roundedRect(38, this.y, width, height - 3, 3).strokeColor(border).lineWidth(.6).stroke().restore()
    this.doc.save().moveTo(38 + width - labelWidth - 10, this.y).lineTo(38 + width - labelWidth - 10, this.y + height - 3)
      .strokeColor(border).lineWidth(.6).stroke().restore()
    this.doc.fillColor(green).font('ArabicBold').text(visual(label), 38 + width - labelWidth - 2, this.y + 5, { width: labelWidth - 8, align: 'right' })
    this.doc.fillColor(ink).font('Arabic').text(visual(value), 46, this.y + 5, { width: valueWidth, align: 'right' })
    this.y += height
  }

  label(text: string): void {
    this.ensure(24)
    this.doc.fillColor(green).font('ArabicBold').fontSize(10).text(visual(text), 42, this.y, { width: this.doc.page.width - 84, align: 'right' })
    this.y += 22
  }

  signoffCards(signoffs: Array<Record<string, unknown>>, images: ReadonlyMap<string, Buffer>): void {
    this.section('التوقيعات الرسمية الثابتة')
    const width = (this.doc.page.width - 88) / 2
    const stages = [signoffs.find(row => ['P1','S1'].includes(String(row.stageCode))), signoffs.find(row => ['P2','S2'].includes(String(row.stageCode)))]
    this.ensure(122)
    stages.forEach((signoff, index) => {
      const x = 38 + index * (width + 12)
      this.doc.save().roundedRect(x, this.y, width, 110, 6).strokeColor(border).stroke().restore()
      if (!signoff) {
        this.doc.fillColor(muted).font('Arabic').fontSize(9).text(visual('لم يُسجل توقيع لهذه الجهة في هذه النسخة'), x + 10, this.y + 42, { width: width - 20, align: 'center' })
        return
      }
      this.doc.fillColor(ink).font('ArabicBold').fontSize(9.5).text(visual(signoff.signerName), x + 9, this.y + 7, { width: width - 18, align: 'right' })
      this.doc.font('Arabic').fontSize(8.5).fillColor(muted).text(visual(signoff.signerJobTitle), x + 9, this.y + 25, { width: width - 18, align: 'right' })
      const image = images.get(String(signoff.signatureAssetId))
      if (image) this.doc.image(image, x + 14, this.y + 48, { fit: [width - 28, 42], align: 'center', valign: 'center' })
      this.doc.fontSize(7.5).fillColor(muted).text(arabicDate(signoff.signedAt), x + 9, this.y + 91, { width: width - 18, align: 'right' })
    })
    this.y += 122
  }

  finish(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let total = 0; let exceeded = false
      this.doc.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > this.maxOutputBytes) {
          exceeded = true
          return
        }
        if (!exceeded) chunks.push(chunk)
      })
      this.doc.once('error', reject)
      this.doc.once('end', () => exceeded ? reject(new Error('PDF output limit exceeded')) : resolve(Buffer.concat(chunks)))
      this.doc.end()
    })
  }
}

export async function renderOfficialPdf(
  snapshot: FormSnapshot,
  signatureImages: ReadonlyMap<string, Buffer>,
  maxOutputBytes: number
): Promise<Buffer> {
  const request = snapshot.request
  const typeLabel = request.requestType === 'PROMOTION' ? 'ترقية' : 'ندب'
  const canvas = new ArabicPdfCanvas(maxOutputBytes, `النموذج الرسمي — ${typeLabel}`)
  canvas.section(stateLabel(snapshot.kind))
  canvas.line('رقم الطلب', request.requestNumber)
  canvas.line('الإدارة / وحدة المسار', request.routingUnitName)
  canvas.line('الدورة وتاريخ النموذج', `${clean(request.cycleYear)} — ${clean(request.formMonth)}/${clean(request.formYear)}`)
  canvas.line('المرحلة في هذه النسخة', snapshot.task?.stageCode ?? request.currentStage)
  canvas.line('سلطة الاعتماد', request.authorityName)

  let currentCategory = ''
  for (const candidate of snapshot.candidates) {
    const category = clean(candidate.jobCategoryName, 'غير مصنف')
    if (category !== currentCategory) { canvas.section('الفئة الوظيفية'); canvas.line('الفئة', category); currentCategory = category }
    canvas.label(clean(candidate.employeeName))
    canvas.line('رقم العامل', candidate.personnelNumber)
    canvas.line('الوظيفة الحالية', candidate.currentJobTitle)
    canvas.line('المؤهل', `${clean(candidate.qualificationSource1)} / ${clean(candidate.qualificationSource2)}`)
    canvas.line('تاريخ المؤهل', candidate.qualificationDate)
    canvas.line('تقييم الأداء', candidate.performanceRating)
    if (request.requestType === 'PROMOTION') {
      const decision = candidate.promotionDecision as Record<string, unknown> | null
      canvas.line('تقرير آخر ترقية', candidate.lastPromotionReport)
      canvas.line('قرار سلطة الاعتماد', decision?.decisionType === 'SAME_POSITION' ? 'الترقية على ذات الوظيفة' : decision?.decisionType === 'OTHER_POSITION' ? 'الترقية على وظيفة أخرى' : '—')
      canvas.line('الوظيفة المستهدفة', decision?.targetJobTitle)
      canvas.line('وحدة المسار المستهدفة', decision?.targetRoutingUnitName)
      canvas.line('ملاحظات القرار', decision?.notes)
    } else {
      const positions = candidate.positions as Array<Record<string, unknown>>
      canvas.label('الوظائف الشاغرة المقترحة وقرار الاختيار')
      if (!positions.length) canvas.line('الوظائف', null)
      for (const position of positions) {
        canvas.line(position.isSelected ? 'الوظيفة المختارة' : 'وظيفة مقترحة',
          `${clean(position.positionTitle)} — ${clean(position.organizationalDependency)} — ${position.qualificationStatus === 'QUALIFIED' ? 'مستوفي' : position.qualificationStatus === 'NOT_QUALIFIED' ? 'غير مستوفي' : '—'}`)
      }
    }
    canvas.label('ملاحظات العامل (ترتيب زمني)')
    const notes = candidate.notes as Array<Record<string, unknown>>
    if (!notes.length) canvas.line('الملاحظات', null)
    for (const note of notes) {
      canvas.line('كاتب الملاحظة', `${clean(note.authorName)} — ${roleLabel(note.authorRole)} — ${arabicDate(note.createdAt)}`)
      canvas.line('نص الملاحظة', note.message)
    }
  }

  const approvalCodes = /SUBMITTED|APPROVED|CONFIRMED|RETURNED|REJECTED|RESTARTED|RECALLED/
  canvas.section('ملخص الاعتمادات والإجراءات')
  const approvals = snapshot.approvals.filter(row => approvalCodes.test(String(row.actionCode)))
  if (!approvals.length) canvas.line('الإجراءات', null)
  for (const approval of approvals) {
    canvas.label(actionLabel(approval.actionCode))
    canvas.line('الفاعل', `${clean(approval.actorName)} (${clean(approval.actorUsername)}) — ${roleLabel(approval.actorRole)}`)
    canvas.line('التوقيت والسبب', `${arabicDate(approval.createdAt)}${approval.reason ? ` — ${clean(approval.reason)}` : ''}`)
  }
  canvas.signoffCards(snapshot.signoffs, signatureImages)
  canvas.section('بيانات الدليل')
  canvas.line('نوع النسخة', stateLabel(snapshot.kind))
  canvas.line('وقت تجميد البيانات', arabicDate(snapshot.capturedAt))
  return await canvas.finish()
}

export async function renderAuditPdf(
  title: string,
  currentStage: string,
  entries: AuditPdfEntry[],
  maxOutputBytes: number
): Promise<Buffer> {
  const canvas = new ArabicPdfCanvas(maxOutputBytes, title)
  canvas.section('نطاق التقرير')
  canvas.line('المرحلة الحالية', currentStage)
  canvas.line('عدد أحداث التدقيق', entries.length)
  canvas.section('سجل التدقيق الكامل')
  if (!entries.length) canvas.line('الأحداث', null)
  for (const entry of entries) {
    canvas.label(`${entry.requestNumber}${entry.candidateName ? ` — ${entry.candidateName}` : ''}`)
    canvas.line('الفاعل', `${clean(entry.actorName)} (${clean(entry.actorUsername)}) — ${roleLabel(entry.actorRole)}`)
    canvas.line('الإجراء والمسار', `${actionLabel(entry.actionCode)} — ${clean(entry.fromStage)} ← ${clean(entry.toStage)}`)
    canvas.line('النتيجة / السبب', entry.reason)
    canvas.line('التوقيت', arabicDate(entry.createdAt))
  }
  return await canvas.finish()
}

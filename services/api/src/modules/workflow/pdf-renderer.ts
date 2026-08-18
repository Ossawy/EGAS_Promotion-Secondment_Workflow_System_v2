import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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

const officialLogoPath = fileURLToPath(
  new URL('../../assets/egas-logo.png', import.meta.url)
)

const officialHeaderBlue = '#BDD3E8'
const officialCategoryGray = '#B9B9B9'
const officialInk = '#111111'
const officialBorder = '#111111'
const officialEgasGreen = '#49683B'

const promotionColumnWidths = {
  serial: 28,
  name: 92,
  currentJob: 174,
  qualification: 112,
  lastPromotionReport: 82,
  samePosition: 92,
  otherPosition: 125
} as const

const secondmentColumnWidths = {
  serial: 28,
  name: 86,
  currentJob: 135,
  qualification: 104,
  lastPromotionReport: 76,
  vacantPosition: 110,
  organizationalDependency: 82,
  qualificationStatus: 78
} as const

const officialPageMargin = 24
const officialHeaderHeight = 74
const officialBottomMargin = 28

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

function visualRtlLine(
  value: unknown,
  fallback = '—'
): string {
  const text =
    clean(value, fallback)

  return text
    .trim()
    .split(/\s+/)
    .reverse()
    .join('  ')
}

function visualRtlMultiline(
  value: unknown,
  fallback = '—'
): string {
  return clean(value, fallback)
    .split('\n')
    .map(line =>
      visualRtlLine(
        line,
        ''
      )
    )
    .join('\n')
}

const arabicMonths: Readonly<Record<number, string>> = {
  1: 'يناير',
  2: 'فبراير',
  3: 'مارس',
  4: 'أبريل',
  5: 'مايو',
  6: 'يونيو',
  7: 'يوليو',
  8: 'أغسطس',
  9: 'سبتمبر',
  10: 'أكتوبر',
  11: 'نوفمبر',
  12: 'ديسمبر'
}

function arabicMonth(value: unknown): string {
  const month = Number(value)
  return arabicMonths[month] ?? clean(value)
}

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

type OfficialTableCell = {
  x: number
  width: number
}



export async function renderOfficialPdfV1(
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

export class OfficialPdfV2Canvas {
  readonly doc: PDFKit.PDFDocument
  private y = officialHeaderHeight

  constructor(
    private readonly maxOutputBytes: number,
    private readonly title: string,
    private readonly period: string
  ) {
    this.doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: {
        top: officialPageMargin,
        right: officialPageMargin,
        bottom: officialBottomMargin,
        left: officialPageMargin
      },
      bufferPages: true,
      compress: true,
      info: {
        Title: title,
        Author: 'EGAS',
        Creator: 'EGAS Workflow System'
      }
    })

    this.doc.registerFont('Arabic', regularFont)
    this.doc.registerFont('ArabicBold', boldFont)
    this.doc.font('Arabic')

    this.header()
  }

  get contentY(): number {
    return this.y
  }

  get contentLeft(): number {
    return officialPageMargin
  }

  get contentRight(): number {
    return this.doc.page.width - officialPageMargin
  }

  get contentWidth(): number {
    return this.contentRight - this.contentLeft
  }

  get contentBottom(): number {
    return this.doc.page.height - officialBottomMargin
  }

  setContentY(value: number): void {
    this.y = value
  }

  add(value: number): void {
    this.y += value
  }

  private promotionColumns(): {
    serial: OfficialTableCell
    name: OfficialTableCell
    currentJob: OfficialTableCell
    qualification: OfficialTableCell
    lastPromotionReport: OfficialTableCell
    samePosition: OfficialTableCell
    otherPosition: OfficialTableCell
    notes: OfficialTableCell
  } {
    let right = this.contentRight

    const take = (
      width: number
    ): OfficialTableCell => {
      const cell = {
        x: right - width,
        width
      }

      right -= width

      return cell
    }

    const serial =
      take(promotionColumnWidths.serial)

    const name =
      take(promotionColumnWidths.name)

    const currentJob =
      take(promotionColumnWidths.currentJob)

    const qualification =
      take(promotionColumnWidths.qualification)

    const lastPromotionReport =
      take(
        promotionColumnWidths.lastPromotionReport
      )

    const samePosition =
      take(promotionColumnWidths.samePosition)

    const otherPosition =
      take(promotionColumnWidths.otherPosition)

    const notes: OfficialTableCell = {
      x: this.contentLeft,
      width: right - this.contentLeft
    }

    return {
      serial,
      name,
      currentJob,
      qualification,
      lastPromotionReport,
      samePosition,
      otherPosition,
      notes
    }
  }

private secondmentColumns(): {
  serial: OfficialTableCell
  name: OfficialTableCell
  currentJob: OfficialTableCell
  qualification: OfficialTableCell
  lastPromotionReport: OfficialTableCell
  vacantPosition: OfficialTableCell
  organizationalDependency: OfficialTableCell
  qualificationStatus: OfficialTableCell
  notes: OfficialTableCell
} {
  let right = this.contentRight

  const take = (
    width: number
  ): OfficialTableCell => {
    const cell = {
      x: right - width,
      width
    }

    right -= width

    return cell
  }

  const serial =
    take(secondmentColumnWidths.serial)

  const name =
    take(secondmentColumnWidths.name)

  const currentJob =
    take(secondmentColumnWidths.currentJob)

  const qualification =
    take(secondmentColumnWidths.qualification)

  const lastPromotionReport =
    take(
      secondmentColumnWidths
        .lastPromotionReport
    )

  const vacantPosition =
    take(
      secondmentColumnWidths
        .vacantPosition
    )

  const organizationalDependency =
    take(
      secondmentColumnWidths
        .organizationalDependency
    )

  const qualificationStatus =
    take(
      secondmentColumnWidths
        .qualificationStatus
    )

  const notes: OfficialTableCell = {
    x: this.contentLeft,
    width: right - this.contentLeft
  }

  return {
    serial,
    name,
    currentJob,
    qualification,
    lastPromotionReport,
    vacantPosition,
    organizationalDependency,
    qualificationStatus,
    notes
  }
}

  private drawTableCell(
    x: number,
    y: number,
    width: number,
    height: number,
    value: unknown,
    options: {
      fill?: string
      bold?: boolean
      fontSize?: number
      align?: 'left' | 'center' | 'right'
    } = {}
  ): void {
    const {
      fill,
      bold = false,
      fontSize = 9.5,
      align = 'center'
    } = options



    if (fill) {
      this.doc
        .save()
        .rect(
          x,
          y,
          width,
          height
        )
        .fill(fill)
        .restore()
    }

    this.doc
      .save()
      .rect(
        x,
        y,
        width,
        height
      )
      .lineWidth(0.8)
      .strokeColor(officialBorder)
      .stroke()
      .restore()

    const text =
      visual(value, '')

    if (!text) {
      return
    }

    this.doc
      .font(
        bold
          ? 'ArabicBold'
          : 'Arabic'
      )
      .fontSize(fontSize)
      .fillColor(officialInk)

    const textWidth =
      Math.max(
        1,
        width - 8
      )

    const textHeight =
      this.doc.heightOfString(
        text,
        {
          width: textWidth,
          align,
          lineGap: 1
        }
      )

    const textY =
      y +
      Math.max(
        3,
        (height - textHeight) / 2
      )

    this.doc.text(
      text,
      x + 4,
      textY,
      {
        width: textWidth,
        align,
        lineGap: 1
      }
    )
  }
private measureTableCellHeight(
  value: unknown,
  width: number,
  options: {
    bold?: boolean
    fontSize?: number
    align?: 'left' | 'center' | 'right'
  } = {}
): number {
  const {
    bold = false,
    fontSize = 9.5,
    align = 'center'
  } = options

  const text = visual(value, '')

  if (!text) {
    return 30
  }

  this.doc
    .font(
      bold
        ? 'ArabicBold'
        : 'Arabic'
    )
    .fontSize(fontSize)

  return Math.max(
    30,
    this.doc.heightOfString(
      text,
      {
        width: Math.max(
          1,
          width - 8
        ),
        align,
        lineGap: 1
      }
    ) + 10
  )
}

preparePromotionCategory(): void {
  const categoryHeight = 25
  const minimumCandidateHeight = 36

  if (
    this.contentY +
      categoryHeight +
      minimumCandidateHeight >
    this.contentBottom
  ) {
    this.addPage()
    this.drawPromotionTableHeader()
  }
}

prepareSecondmentCategory(): void {
  const categoryHeight = 25
  const minimumCandidateHeight = 42

  if (
    this.contentY +
      categoryHeight +
      minimumCandidateHeight >
    this.contentBottom
  ) {
    this.addPage()
    this.drawSecondmentTableHeader()
  }
}

  drawPromotionTableHeader(): void {
    const columns =
      this.promotionColumns()

    const firstHeaderHeight = 28
    const secondHeaderHeight = 40

    const totalHeight =
      firstHeaderHeight +
      secondHeaderHeight

    this.ensure(totalHeight)

    const y = this.contentY

    this.drawTableCell(
      columns.serial.x,
      y,
      columns.serial.width,
      totalHeight,
      'م',
      {
        fill: officialHeaderBlue,
        bold: true,
        fontSize: 10
      }
    )

    this.drawTableCell(
      columns.name.x,
      y,
      columns.name.width,
      totalHeight,
      'اسم المرشح',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    this.drawTableCell(
      columns.currentJob.x,
      y,
      columns.currentJob.width,
      totalHeight,
      'الوظيفة الحالية',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    this.drawTableCell(
      columns.qualification.x,
      y,
      columns.qualification.width,
      totalHeight,
      'المؤهل الدراسي وتاريخه',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    this.drawTableCell(
      columns.lastPromotionReport.x,
      y,
      columns.lastPromotionReport.width,
      totalHeight,
      'تقرير آخر ترقية',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    /*
     * Parent heading spanning the two
     * promotion-decision columns.
     */
    this.drawTableCell(
      columns.otherPosition.x,
      y,
      columns.samePosition.width +
        columns.otherPosition.width,
      firstHeaderHeight,
      'الوظيفة المرشح لشغلها',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    this.drawTableCell(
      columns.samePosition.x,
      y + firstHeaderHeight,
      columns.samePosition.width,
      secondHeaderHeight,
      'ترقية على نفس الوظيفة',
      {
        fill: officialHeaderBlue,
        bold: true,
        fontSize: 8.5
      }
    )

    this.drawTableCell(
      columns.otherPosition.x,
      y + firstHeaderHeight,
      columns.otherPosition.width,
      secondHeaderHeight,
      'ترقية على وظيفة أخرى مع ذكر الوظيفة',
      {
        fill: officialHeaderBlue,
        bold: true,
        fontSize: 8.2
      }
    )

    this.drawTableCell(
      columns.notes.x,
      y,
      columns.notes.width,
      totalHeight,
      'ملاحظات',
      {
        fill: officialHeaderBlue,
        bold: true
      }
    )

    this.setContentY(
      y + totalHeight
    )
  }

  drawSecondmentTableHeader(): void {
  const columns =
    this.secondmentColumns()

  const headerHeight = 68

  this.ensure(headerHeight)

  const y =
    this.contentY

  this.drawTableCell(
    columns.serial.x,
    y,
    columns.serial.width,
    headerHeight,
    'م',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 10
    }
  )

  this.drawTableCell(
    columns.name.x,
    y,
    columns.name.width,
    headerHeight,
    'اسم المرشح',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 9
    }
  )

  this.drawTableCell(
    columns.currentJob.x,
    y,
    columns.currentJob.width,
    headerHeight,
    'الوظيفة الحالية',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 9
    }
  )

  this.drawTableCell(
    columns.qualification.x,
    y,
    columns.qualification.width,
    headerHeight,
    'المؤهل الدراسي وتاريخه',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 8.6
    }
  )

  this.drawTableCell(
    columns.lastPromotionReport.x,
    y,
    columns.lastPromotionReport.width,
    headerHeight,
    'تقرير آخر ترقية',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 8.5
    }
  )

  this.drawTableCell(
    columns.vacantPosition.x,
    y,
    columns.vacantPosition.width,
    headerHeight,
    'الوظائف الشاغرة والتى يجوز الندب لشغلها',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 8.2
    }
  )

  this.drawTableCell(
    columns.organizationalDependency.x,
    y,
    columns.organizationalDependency.width,
    headerHeight,
    'التبعية التنظيمية',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 8.5
    }
  )

  /*
   * Avoid "/" here because mixed-direction
   * punctuation caused visual RTL issues.
   */
  this.drawTableCell(
    columns.qualificationStatus.x,
    y,
    columns.qualificationStatus.width,
    headerHeight,
    'استيفاء أو عدم استيفاء مطالب تأهيل شغل الوظيفة',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 7.8
    }
  )

  this.drawTableCell(
    columns.notes.x,
    y,
    columns.notes.width,
    headerHeight,
    'ملاحظات',
    {
      fill: officialHeaderBlue,
      bold: true,
      fontSize: 9
    }
  )

  this.setContentY(
    y + headerHeight
  )
}

  drawCategoryRow(
    categoryName: unknown,
    continued = false
  ): void {
    const height = 25

    this.ensure(height)

    const raw =
      clean(
        categoryName,
        'غير مصنف'
      )

    const normalized =
      raw.startsWith('وظيفة')
        ? raw
        : `وظيفة ${raw}`

    const label =
  continued
    ? `${normalized} - تابع`
    : normalized

    this.drawTableCell(
      this.contentLeft,
      this.contentY,
      this.contentWidth,
      height,
      label,
      {
        fill: officialCategoryGray,
        bold: true,
        fontSize: 10,
        align: 'right'
      }
    )

    this.add(height)
  }
drawPromotionCandidateRow(
  candidate: FormSnapshot['candidates'][number],
  serial: number,
  categoryName: string
): void {
  const columns =
    this.promotionColumns()

  const decision =
    candidate.promotionDecision as
      Record<string, unknown> | null

  /*
   * Qualification:
   *
   * source 1
   * source 2
   * qualification date
   */
  const qualificationParts = [
    clean(
      candidate.qualificationSource1,
      ''
    ),
    clean(
      candidate.qualificationSource2,
      ''
    )
  ].filter(Boolean)

  const qualificationDate =
    clean(
      candidate.qualificationDate,
      ''
    )

  const qualificationText = [
    qualificationParts.join(' / '),
    qualificationDate
  ]
    .filter(Boolean)
    .join('\n')

  /*
   * Promotion decision columns.
   *
   * SAME_POSITION:
   *     ✓ only
   *
   * OTHER_POSITION:
   *     target job
   *     target routing unit
   */
  const decisionType =
    String(
      decision?.decisionType ?? ''
    )

  const samePositionText =
    decisionType === 'SAME_POSITION'
      ? '✓'
      : ''

  const otherPositionText =
    decisionType === 'OTHER_POSITION'
      ? [
          clean(
            decision?.targetJobTitle,
            ''
          ),
          clean(
            decision?.targetRoutingUnitName,
            ''
          )
        ]
          .filter(Boolean)
          .join('\n')
      : ''

  /*
   * Candidate workflow notes.
   */
  const notes =
    (
      candidate.notes as
        Array<Record<string, unknown>>
    )
      .map(note =>
        clean(note.message, '')
      )
      .filter(Boolean)
      .join('\n')

  /*
   * Determine one height for the entire
   * candidate row based on its tallest cell.
   */
  const rowHeight =
    Math.max(
      36,

      this.measureTableCellHeight(
        serial,
        columns.serial.width
      ),

      this.measureTableCellHeight(
        candidate.employeeName,
        columns.name.width
      ),

      this.measureTableCellHeight(
        candidate.currentJobTitle,
        columns.currentJob.width
      ),

      this.measureTableCellHeight(
        qualificationText,
        columns.qualification.width,
        {
          fontSize: 8.8
        }
      ),

      this.measureTableCellHeight(
        candidate.lastPromotionReport,
        columns.lastPromotionReport.width,
        {
          fontSize: 8.8
        }
      ),

      this.measureTableCellHeight(
        samePositionText,
        columns.samePosition.width,
        {
          bold: true,
          fontSize: 14
        }
      ),

      this.measureTableCellHeight(
        otherPositionText,
        columns.otherPosition.width,
        {
          fontSize: 8.8
        }
      ),

      this.measureTableCellHeight(
        notes,
        columns.notes.width,
        {
          fontSize: 8.5
        }
      )
    )

  /*
   * Candidate rows are atomic:
   * never split one candidate over two pages.
   *
   * A continuation page repeats:
   * - EGAS header/title
   * - Promotion table header
   * - current category
   */
  if (
    this.contentY +
      rowHeight >
    this.contentBottom
  ) {
    this.addPage()

    this.drawPromotionTableHeader()

    this.drawCategoryRow(
      categoryName,
      true
    )
  }

  const y =
    this.contentY

  this.drawTableCell(
    columns.serial.x,
    y,
    columns.serial.width,
    rowHeight,
    serial
  )

  this.drawTableCell(
    columns.name.x,
    y,
    columns.name.width,
    rowHeight,
    candidate.employeeName,
    {
      fontSize: 9
    }
  )

  this.drawTableCell(
    columns.currentJob.x,
    y,
    columns.currentJob.width,
    rowHeight,
    candidate.currentJobTitle,
    {
      fontSize: 9
    }
  )

  this.drawTableCell(
    columns.qualification.x,
    y,
    columns.qualification.width,
    rowHeight,
    qualificationText,
    {
      fontSize: 8.8
    }
  )

  this.drawTableCell(
    columns.lastPromotionReport.x,
    y,
    columns.lastPromotionReport.width,
    rowHeight,
    candidate.lastPromotionReport,
    {
      fontSize: 8.8
    }
  )

  this.drawTableCell(
    columns.samePosition.x,
    y,
    columns.samePosition.width,
    rowHeight,
    samePositionText,
    {
      bold: true,
      fontSize: 14
    }
  )

  this.drawTableCell(
    columns.otherPosition.x,
    y,
    columns.otherPosition.width,
    rowHeight,
    otherPositionText,
    {
      fontSize: 8.8
    }
  )

  this.drawTableCell(
    columns.notes.x,
    y,
    columns.notes.width,
    rowHeight,
    notes,
    {
      fontSize: 8.5,
      align: 'right'
    }
  )

  this.add(rowHeight)
}

drawSecondmentCandidateRows(
  candidate: FormSnapshot['candidates'][number],
  serial: number,
  categoryName: string
): void {
  const columns =
    this.secondmentColumns()

  /*
   * Candidate-level qualification.
   */
  const qualificationParts = [
    clean(
      candidate.qualificationSource1,
      ''
    ),
    clean(
      candidate.qualificationSource2,
      ''
    )
  ].filter(Boolean)

  const qualificationDate =
    clean(
      candidate.qualificationDate,
      ''
    )

  const qualificationText = [
    qualificationParts.join(' / '),
    qualificationDate
  ]
    .filter(Boolean)
    .join('\n')

  /*
   * Candidate-level workflow notes.
   */
  const notes =
    (
      candidate.notes as
        Array<Record<string, unknown>>
    )
      .map(note =>
        clean(note.message, '')
      )
      .filter(Boolean)
      .join('\n')

  /*
   * A Secondment candidate can have
   * multiple vacancy rows.
   *
   * If no position exists yet, render
   * one empty position row so the
   * candidate still appears in the form.
   */
  const sourcePositions =
    candidate.positions as
      Array<Record<string, unknown>>

  const positions =
    sourcePositions.length
      ? sourcePositions
      : [{}]

  const positionRows =
    positions.map(position => {
      const selected =
        position.isSelected === true

      const positionTitle =
        clean(
          position.positionTitle,
          ''
        )

      const vacancyText =
        selected
          ? [
              '✓',
              positionTitle
            ]
              .filter(Boolean)
              .join('\n')
          : positionTitle

      const dependencyText =
        clean(
          position.organizationalDependency,
          ''
        )

      const statusCode =
        String(
          position.qualificationStatus ?? ''
        )

      const qualificationStatusText =
        statusCode === 'QUALIFIED'
          ? 'مستوفي'
          : statusCode ===
              'NOT_QUALIFIED'
            ? 'غير مستوفي'
            : ''

      const height =
        Math.max(
          34,

          this.measureTableCellHeight(
            vacancyText,
            columns.vacantPosition.width,
            {
              bold: selected,
              fontSize: 8.6
            }
          ),

          this.measureTableCellHeight(
            dependencyText,
            columns.organizationalDependency.width,
            {
              fontSize: 8.4
            }
          ),

          this.measureTableCellHeight(
            qualificationStatusText,
            columns.qualificationStatus.width,
            {
              fontSize: 8.4
            }
          )
        )

      return {
        position,
        selected,
        vacancyText,
        dependencyText,
        qualificationStatusText,
        height
      }
    })

  /*
   * Candidate-level cells are vertically
   * merged across the position rows.
   *
   * Measure the minimum height needed for
   * those merged cells.
   */
  const candidateMergedHeight =
    Math.max(
      42,

      this.measureTableCellHeight(
        serial,
        columns.serial.width
      ),

      this.measureTableCellHeight(
        candidate.employeeName,
        columns.name.width,
        {
          fontSize: 8.8
        }
      ),

      this.measureTableCellHeight(
        candidate.currentJobTitle,
        columns.currentJob.width,
        {
          fontSize: 8.7
        }
      ),

      this.measureTableCellHeight(
        qualificationText,
        columns.qualification.width,
        {
          fontSize: 8.4
        }
      ),

      this.measureTableCellHeight(
        candidate.lastPromotionReport,
        columns.lastPromotionReport.width,
        {
          fontSize: 8.3
        }
      ),

      this.measureTableCellHeight(
        notes,
        columns.notes.width,
        {
          fontSize: 8.3,
          align: 'right'
        }
      )
    )

  /*
   * Draw one page-sized chunk of the
   * candidate.
   *
   * Candidate-level cells span all vacancy
   * rows in this chunk.
   */
  const drawChunk = (
    rows: typeof positionRows
  ): void => {
    let totalHeight =
      rows.reduce(
        (
          total,
          row
        ) =>
          total + row.height,
        0
      )

    /*
     * If the candidate-level information
     * needs more vertical room than the
     * vacancy rows, enlarge the final
     * vacancy row.
     */
    if (
      totalHeight <
      candidateMergedHeight
    ) {
      const extra =
        candidateMergedHeight -
        totalHeight

      rows[
        rows.length - 1
      ]!.height += extra

      totalHeight =
        candidateMergedHeight
    }

    const y =
      this.contentY

    /*
     * Vertically merged candidate cells.
     */
    this.drawTableCell(
      columns.serial.x,
      y,
      columns.serial.width,
      totalHeight,
      serial
    )

    this.drawTableCell(
      columns.name.x,
      y,
      columns.name.width,
      totalHeight,
      candidate.employeeName,
      {
        fontSize: 8.8
      }
    )

    this.drawTableCell(
      columns.currentJob.x,
      y,
      columns.currentJob.width,
      totalHeight,
      candidate.currentJobTitle,
      {
        fontSize: 8.7
      }
    )

    this.drawTableCell(
      columns.qualification.x,
      y,
      columns.qualification.width,
      totalHeight,
      qualificationText,
      {
        fontSize: 8.4
      }
    )

    this.drawTableCell(
      columns.lastPromotionReport.x,
      y,
      columns.lastPromotionReport.width,
      totalHeight,
      candidate.lastPromotionReport,
      {
        fontSize: 8.3
      }
    )

    this.drawTableCell(
      columns.notes.x,
      y,
      columns.notes.width,
      totalHeight,
      notes,
      {
        fontSize: 8.3,
        align: 'right'
      }
    )

    /*
     * Vacancy-specific rows.
     */
    let rowY = y

    for (const row of rows) {
      this.drawTableCell(
        columns.vacantPosition.x,
        rowY,
        columns.vacantPosition.width,
        row.height,
        row.vacancyText,
        {
          bold: row.selected,
          fontSize:
            row.selected
              ? 9
              : 8.6
        }
      )

      this.drawTableCell(
        columns.organizationalDependency.x,
        rowY,
        columns.organizationalDependency.width,
        row.height,
        row.dependencyText,
        {
          fontSize: 8.4
        }
      )

      this.drawTableCell(
        columns.qualificationStatus.x,
        rowY,
        columns.qualificationStatus.width,
        row.height,
        row.qualificationStatusText,
        {
          fontSize: 8.4
        }
      )

      rowY +=
        row.height
    }

    this.add(totalHeight)
  }

  /*
   * Prefer keeping the entire candidate
   * together when it fits.
   */
  const fullBaseHeight =
    positionRows.reduce(
      (
        total,
        row
      ) =>
        total + row.height,
      0
    )

  const fullCandidateHeight =
    Math.max(
      fullBaseHeight,
      candidateMergedHeight
    )

  if (
    this.contentY +
      fullCandidateHeight <=
    this.contentBottom
  ) {
    drawChunk(positionRows)
    return
  }

  /*
   * If the whole candidate fits on a fresh
   * page, move it before drawing anything.
   */
  this.addPage()

  this.drawSecondmentTableHeader()

  this.drawCategoryRow(
    categoryName,
    true
  )

  const freshPageCapacity =
    this.contentBottom -
    this.contentY

  if (
    fullCandidateHeight <=
    freshPageCapacity
  ) {
    drawChunk(positionRows)
    return
  }

  /*
   * Large candidate:
   * split only between vacancy rows.
   *
   * Candidate-level cells are repeated on
   * each continuation page; an individual
   * vacancy row is never split.
   */
  let remaining =
    [...positionRows]

  while (
    remaining.length
  ) {
    const available =
      this.contentBottom -
      this.contentY

    if (
      candidateMergedHeight >
      available
    ) {
      /*
       * If candidate-level content cannot
       * physically fit on an otherwise
       * normal continuation page, fail
       * rather than clipping evidence.
       */
      throw new Error(
        'Secondment candidate content exceeds page capacity'
      )
    }

    const chunk:
      typeof positionRows = []

    let usedHeight = 0

    while (
      remaining.length
    ) {
      const next =
        remaining[0]!

      if (
        chunk.length > 0 &&
        usedHeight +
          next.height >
          available
      ) {
        break
      }

      if (
        chunk.length === 0 &&
        next.height >
          available
      ) {
        throw new Error(
          'Secondment vacancy row exceeds page capacity'
        )
      }

      chunk.push(
        remaining.shift()!
      )

      usedHeight +=
        next.height
    }

    drawChunk(chunk)

    if (
      remaining.length
    ) {
      this.addPage()

      this.drawSecondmentTableHeader()

      this.drawCategoryRow(
        categoryName,
        true
      )
    }
  }
}

private drawOfficialSignatureBlock(
  x: number,
  y: number,
  width: number,
  height: number,
  roleTitle: string,
  signoff: Record<string, unknown> | undefined,
  signatureImages: ReadonlyMap<string, Buffer>
): void {
  /*
   * Role heading.
   */
  this.doc
    .fillColor(officialInk)
    .font('ArabicBold')
    .fontSize(11)
    .text(
      visualRtlLine(roleTitle),
      x,
      y,
      {
        width,
        align: 'center'
      }
    )

  /*
   * Signature area.
   */
  const signatureTop =
    y + 22

  const signatureHeight = 42

  const signatureAssetId =
    String(
      signoff?.signatureAssetId ?? ''
    )

  const signatureImage =
    signatureAssetId
      ? signatureImages.get(
          signatureAssetId
        )
      : undefined

  if (signatureImage) {
    this.doc.image(
      signatureImage,
      x + 18,
      signatureTop,
      {
        fit: [
          width - 36,
          signatureHeight
        ],
        align: 'center',
        valign: 'center'
      }
    )
  } else {
    /*
     * Approved empty state before
     * this signoff exists.
     */
    this.doc
      .save()
      .moveTo(
        x + 34,
        signatureTop +
          signatureHeight -
          2
      )
      .lineTo(
        x + width - 34,
        signatureTop +
          signatureHeight -
          2
      )
      .lineWidth(0.6)
      .strokeColor(officialBorder)
      .stroke()
      .restore()
  }

  /*
   * Frozen signer identity.
   *
   * Do not invent data when the
   * signoff has not happened yet.
   */
  if (signoff) {
    const signerName =
      clean(
        signoff.signerName,
        ''
      )

    const signerJobTitle =
      clean(
        signoff.signerJobTitle,
        ''
      )

    if (signerName) {
      this.doc
        .fillColor(officialInk)
        .font('ArabicBold')
        .fontSize(9)
        .text(
          visualRtlLine(signerName),
          x + 6,
          y + 68,
          {
            width: width - 12,
            align: 'center'
          }
        )
    }

    if (signerJobTitle) {
      this.doc
        .fillColor(officialInk)
        .font('Arabic')
        .fontSize(8.5)
        .text(
          visualRtlLine(signerJobTitle),
          x + 6,
          y + 84,
          {
            width: width - 12,
            align: 'center'
          }
        )
    }
  }

  /*
   * Bottom signature caption.
   */
  this.doc
    .fillColor(officialInk)
    .font('Arabic')
    .fontSize(8.5)
    .text(
      visualRtlLine('التوقيع'),
      x,
      y + height - 16,
      {
        width,
        align: 'center'
      }
    )
}

drawPromotionFooter(
  signoffs: FormSnapshot['signoffs'],
  signatureImages: ReadonlyMap<string, Buffer>
): void {
  const instructionsHeight = 34
  const signatureHeight = 112
  const gapAfterTable = 12
  const gapBeforeSignatures = 8

  const requiredHeight =
    gapAfterTable +
    instructionsHeight +
    gapBeforeSignatures +
    signatureHeight

  /*
   * Both signatures must remain on
   * the same page and same row.
   */
  if (
    this.contentY +
      requiredHeight >
    this.contentBottom
  ) {
    this.addPage()
  }

  this.add(gapAfterTable)

  /*
   * Instructions from the official
   * source form.
   */
  this.doc
    .fillColor(officialInk)
    .font('Arabic')
    .fontSize(8.5)
    .text(
      visualRtlLine(
        'يتم إضافة المؤهل الدراسي وتاريخه بالنموذج'
      ),
      this.contentLeft,
      this.contentY,
      {
        width: this.contentWidth,
        align: 'right'
      }
    )

  this.doc
    .text(
      visualRtlLine(
        'يتم إضافة تقرير آخر ترقية'
      ),
      this.contentLeft,
      this.contentY + 15,
      {
        width: this.contentWidth,
        align: 'right'
      }
    )

  this.add(
    instructionsHeight +
      gapBeforeSignatures
  )

  /*
   * Promotion official signoffs:
   *
   * P1 = Employee Affairs
   * P2 = Organization
   */
  const employeeAffairs =
    signoffs.find(
      row =>
        String(row.stageCode) ===
        'P1'
    ) as
      | Record<string, unknown>
      | undefined

  const organization =
    signoffs.find(
      row =>
        String(row.stageCode) ===
        'P2'
    ) as
      | Record<string, unknown>
      | undefined

  const gap = 70

  const blockWidth =
    (
      this.contentWidth -
      gap
    ) / 2

  const y =
    this.contentY

  /*
   * Right-hand block:
   * Employee Affairs.
   */
  const employeeAffairsX =
    this.contentRight -
    blockWidth

  this.drawOfficialSignatureBlock(
    employeeAffairsX,
    y,
    blockWidth,
    signatureHeight,
    'شئون العاملين',
    employeeAffairs,
    signatureImages
  )

  /*
   * Left-hand block:
   * Organization.
   */
  const organizationX =
    this.contentLeft

  this.drawOfficialSignatureBlock(
    organizationX,
    y,
    blockWidth,
    signatureHeight,
    'إدارة التنظيم',
    organization,
    signatureImages
  )

  this.add(signatureHeight)
}

drawSecondmentFooter(
  signoffs: FormSnapshot['signoffs'],
  signatureImages: ReadonlyMap<string, Buffer>
): void {
  const instructionsHeight = 34
  const signatureHeight = 112
  const gapAfterTable = 12
  const gapBeforeSignatures = 8

  const requiredHeight =
    gapAfterTable +
    instructionsHeight +
    gapBeforeSignatures +
    signatureHeight

  /*
   * Keep both signature blocks together
   * on the same page.
   */
  if (
    this.contentY +
      requiredHeight >
    this.contentBottom
  ) {
    this.addPage()
  }

  this.add(gapAfterTable)

  /*
   * Official source-form instructions.
   */
  this.doc
    .fillColor(officialInk)
    .font('Arabic')
    .fontSize(8.5)
    .text(
      visualRtlLine(
        'يتم إضافة المؤهل الدراسي وتاريخه بالنموذج'
      ),
      this.contentLeft,
      this.contentY,
      {
        width: this.contentWidth,
        align: 'right'
      }
    )

  this.doc.text(
    visualRtlLine(
      'يتم إضافة تقرير آخر ترقية'
    ),
    this.contentLeft,
    this.contentY + 15,
    {
      width: this.contentWidth,
      align: 'right'
    }
  )

  this.add(
    instructionsHeight +
      gapBeforeSignatures
  )

  /*
   * Secondment official signoffs:
   *
   * S1 = Employee Affairs
   * S2 = Organization
   */
  const employeeAffairs =
    signoffs.find(
      row =>
        String(row.stageCode) ===
        'S1'
    ) as
      | Record<string, unknown>
      | undefined

  const organization =
    signoffs.find(
      row =>
        String(row.stageCode) ===
        'S2'
    ) as
      | Record<string, unknown>
      | undefined

  const gap = 70

  const blockWidth =
    (
      this.contentWidth -
      gap
    ) / 2

  const y =
    this.contentY

  /*
   * Right side:
   * Employee Affairs.
   */
  const employeeAffairsX =
    this.contentRight -
    blockWidth

  this.drawOfficialSignatureBlock(
    employeeAffairsX,
    y,
    blockWidth,
    signatureHeight,
    'شئون العاملين',
    employeeAffairs,
    signatureImages
  )

  /*
   * Left side:
   * Organization.
   */
  const organizationX =
    this.contentLeft

  this.drawOfficialSignatureBlock(
    organizationX,
    y,
    blockWidth,
    signatureHeight,
    'إدارة التنظيم',
    organization,
    signatureImages
  )

  this.add(signatureHeight)
}

  private header(): void {
    const pageWidth =
      this.doc.page.width

    const titleWidth =
      pageWidth -
      officialPageMargin * 2

    this.doc.save()

    this.doc.image(
      officialLogoPath,
      officialPageMargin,
      officialPageMargin,
      {
        width: 60
      }
    )

    this.doc
      .fillColor(officialEgasGreen)
      .font('ArabicBold')
      .fontSize(14)
      .text(
        visualRtlLine(
          'الشركة المصرية القابضة للغازات الطبيعية'
        ),
        pageWidth -
          officialPageMargin -
          260,
        officialPageMargin + 5,
        {
          width: 260,
          align: 'right'
        }
      )

    this.doc
      .fontSize(12)
      .text(
        visualRtlLine('الشئون الإدارية'),
        pageWidth -
          officialPageMargin -
          260,
        officialPageMargin + 25,
        {
          width: 260,
          align: 'right'
        }
      )

    this.doc.restore()

    this.doc
      .fillColor(officialInk)
      .font('ArabicBold')
      .fontSize(18)
      .text(
        visualRtlMultiline(this.title),
        officialPageMargin,
        officialHeaderHeight - 20,
        {
          width: titleWidth,
          align: 'center'
        }
      )

    const titleHeight =
      this.doc.heightOfString(
        visualRtlMultiline(this.title),
        {
          width: titleWidth,
          align: 'center'
        }
      )

    const periodY =
      officialHeaderHeight -
      20 +
      titleHeight +
      4

    const renderedPeriod =
  visualRtlLine(`حركة ${this.period}`)

this.doc
  .font('Arabic')
  .fontSize(14)
  .text(
    renderedPeriod,
    officialPageMargin,
    periodY,
    {
      width: titleWidth,
      align: 'center',
      underline: true
    }
  )

const periodHeight =
  this.doc.heightOfString(
    renderedPeriod,
    {
      width: titleWidth,
      align: 'center'
    }
  )

    this.y =
      periodY +
      periodHeight +
      12
  }

  private addPage(): void {
    this.doc.addPage({
      size: 'A4',
      layout: 'landscape',
      margins: {
        top: officialPageMargin,
        right: officialPageMargin,
        bottom: officialBottomMargin,
        left: officialPageMargin
      }
    })

    this.header()
  }

  ensure(height: number): void {
    if (
      this.y + height >
      this.contentBottom
    ) {
      this.addPage()
    }
  }

  finish(): Promise<Buffer> {
    return new Promise<Buffer>(
      (resolve, reject) => {
        const chunks: Buffer[] = []

        let total = 0
        let exceeded = false

        this.doc.on(
          'data',
          (chunk: Buffer) => {
            total += chunk.length

            if (
              total >
              this.maxOutputBytes
            ) {
              exceeded = true
              return
            }

            if (!exceeded) {
              chunks.push(chunk)
            }
          }
        )

        this.doc.once(
          'error',
          reject
        )

        this.doc.once(
          'end',
          () => {
            if (exceeded) {
              reject(
                new Error(
                  'PDF output limit exceeded'
                )
              )

              return
            }

            resolve(
              Buffer.concat(chunks)
            )
          }
        )

        this.doc.end()
      }
    )
  }
}

export async function renderOfficialPdfV2(
  snapshot: FormSnapshot,
  signatureImages: ReadonlyMap<string, Buffer>,
  maxOutputBytes: number
): Promise<Buffer> {
  const request =
    snapshot.request

  const routingUnitName =
    clean(
      request.routingUnitName
    )

  const title =
    request.requestType === 'PROMOTION'
      ? `بيان بموقف الوظائف التى يمكن الترقية عليها بالمستوى الأول فأقل
بنيابة / مساعد ${routingUnitName}`
      : `بيان بموقف الوظائف التى يمكن شغلها ندب بالمستوى الأول فأقل
بنيابة ${routingUnitName}`

  const canvas =
    new OfficialPdfV2Canvas(
      maxOutputBytes,
      title,
      `${arabicMonth(
        request.formMonth
      )} ${clean(
        request.formYear
      )}`
    )

  /*
   * Promotion
   */
  if (
    request.requestType ===
    'PROMOTION'
  ) {
    canvas.drawPromotionTableHeader()

    let currentCategory = ''
    let serial = 0

    for (
      const candidate
      of snapshot.candidates
    ) {
      const category =
        clean(
          candidate.jobCategoryName,
          'غير مصنف'
        )

      if (
        category !==
        currentCategory
      ) {
        canvas.preparePromotionCategory()

        canvas.drawCategoryRow(
          category
        )

        currentCategory =
          category

        serial = 0
      }

      serial += 1

      canvas.drawPromotionCandidateRow(
        candidate,
        serial,
        category
      )
    }

    canvas.drawPromotionFooter(
      snapshot.signoffs,
      signatureImages
    )
  }

  /*
   * Secondment
   */
  if (
    request.requestType ===
    'SECONDMENT'
  ) {
    canvas.drawSecondmentTableHeader()

    let currentCategory = ''
    let serial = 0

    for (
      const candidate
      of snapshot.candidates
    ) {
      const category =
        clean(
          candidate.jobCategoryName,
          'غير مصنف'
        )

      if (
        category !==
        currentCategory
      ) {
        canvas.prepareSecondmentCategory()

        canvas.drawCategoryRow(
          category
        )

        currentCategory =
          category

        serial = 0
      }

      serial += 1

      canvas.drawSecondmentCandidateRows(
        candidate,
        serial,
        category
      )
    }

    canvas.drawSecondmentFooter(
      snapshot.signoffs,
      signatureImages
    )
  }

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

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import type { FinalFormSnapshotPayload } from './form-snapshot.ts'

export type AuditPdfEntry = {
  requestNumber: string
  iterationNo: number
  stageCode: string | null
  actorName: string | null
  actorUsername: string | null
  actionType: string
  reason: string | null
  details: Record<string, unknown>
  createdAt: string
}

const require = createRequire(import.meta.url)
const regularFont = require.resolve('@ibm/plex-sans-arabic/fonts/complete/woff/IBMPlexSansArabic-Regular.woff')
const boldFont = require.resolve('@ibm/plex-sans-arabic/fonts/complete/woff/IBMPlexSansArabic-Bold.woff')

const officialLogoPath = fileURLToPath(
  new URL('../../assets/egas-logo.png', import.meta.url)
)

const green = '#075b3b'
const pale = '#eaf4ee'
const ink = '#153329'
const muted = '#5f726b'
const border = '#c9d8d0'

type RenderHeaderCell = { label: string, w: number }
type RenderValueCell = { val: unknown, w: number }

function clean(value: unknown, fallback = '—'): string {
  if (value === undefined || value === null || value === '') return fallback
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 4_000) || fallback
}

function visual(value: unknown, fallback = '—'): string {
  return clean(value, fallback).replace(/ /g, '  ')
}

function visualRtlLine(value: unknown, fallback = '—'): string {
  const text = clean(value, fallback).trim()
  if (!/[\u0600-\u06ff]/.test(text)) return text
  return text
    .split(/\s+/)
    .reverse()
    .join('  ')
}

function arabicDate(value: unknown): string {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Cairo'
    }).format(new Date(String(value)))
  } catch {
    return clean(value)
  }
}

export function renderOfficialFormPdf(
  snapshot: FinalFormSnapshotPayload,
  signatureImages: ReadonlyMap<string, Buffer>,
  maxOutputBytes: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const isPromotion = snapshot.requestType === 'PROMOTION'
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 30, right: 30, bottom: 30, left: 30 },
      bufferPages: true,
      compress: true,
      info: {
        Title: isPromotion ? 'كشف ترقيات العاملين' : 'كشف ترشيح شغل وظائف بالندب',
        Author: 'EGAS',
        Creator: 'EGAS Promotion & Secondment System v5'
      }
    })

    doc.registerFont('Arabic', regularFont)
    doc.registerFont('ArabicBold', boldFont)
    doc.font('Arabic')

    // PDFKit lays Arabic words out visually but does not provide reliable bidi
    // paragraph wrapping. Wrap the logical text first, then convert each fitted
    // line separately so the original top-to-bottom line order is retained.
    const wrapForPdf = (value: unknown, width: number, fallback = '—'): string => {
      const logicalLines = clean(value, fallback).split('\n')
      const visualLines: string[] = []
      for (const logicalLine of logicalLines) {
        const toVisual = (line: string) => /[\u0600-\u06ff]/.test(line) ? visualRtlLine(line, '') : line
        const fits = (line: string) => doc.widthOfString(toVisual(line)) <= width
        const splitLongWord = (word: string): string[] => {
          if (fits(word)) return [word]
          const fragments: string[] = []
          let fragment = ''
          for (const character of Array.from(word)) {
            const candidate = `${fragment}${character}`
            if (fragment && !fits(candidate)) {
              fragments.push(fragment)
              fragment = character
            } else {
              fragment = candidate
            }
          }
          if (fragment) fragments.push(fragment)
          return fragments
        }
        const words = logicalLine.trim().split(/\s+/).filter(Boolean).flatMap(splitLongWord)
        if (!words.length) {
          visualLines.push('')
          continue
        }
        let currentLine = ''
        for (const word of words) {
          const candidate = currentLine ? `${currentLine} ${word}` : word
          if (currentLine && !fits(candidate)) {
            visualLines.push(toVisual(currentLine))
            currentLine = word
          } else {
            currentLine = candidate
          }
        }
        visualLines.push(toVisual(currentLine))
      }
      return visualLines.join('\n')
    }

    const preparedTextHeight = (value: unknown, width: number, lineGap = 1): number => {
      const lines = wrapForPdf(value, width).split('\n')
      return lines.length * doc.currentLineHeight() + Math.max(0, lines.length - 1) * lineGap
    }

    const drawPreparedText = (
      value: unknown,
      x: number,
      y: number,
      width: number,
      align: 'left' | 'center' | 'right',
      lineGap = 1
    ): void => {
      const lines = wrapForPdf(value, width).split('\n')
      const lineHeight = doc.currentLineHeight() + lineGap
      lines.forEach((line, index) => {
        doc.text(line, x, y + index * lineHeight, { width, align, lineGap, lineBreak: false })
      })
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    let exceeded = false

    doc.on('data', chunk => {
      totalBytes += chunk.length
      if (totalBytes > maxOutputBytes) {
        exceeded = true
        return
      }
      if (!exceeded) chunks.push(chunk)
    })

    doc.once('error', reject)
    doc.once('end', () => {
      if (exceeded) {
        reject(new Error('PDF output limit exceeded'))
      } else {
        resolve(Buffer.concat(chunks))
      }
    })

    // Header
    const pageWidth = doc.page.width
    const contentWidth = pageWidth - 60

    try {
      doc.image(officialLogoPath, 35, 25, { width: 70 })
    } catch {
      // Fallback if logo not found
    }

    const companyX = pageWidth - 350
    const companyWidth = 315
    doc.font('ArabicBold').fontSize(11).fillColor(green)
    drawPreparedText('الشركة المصرية القابضة للغازات الطبيعية', companyX, 27, companyWidth, 'right')
    doc.font('ArabicBold').fontSize(12).fillColor(ink)
    drawPreparedText(
      isPromotion
        ? 'بيان بالسادة العاملين الذين يمكن النظر في أمر شغلهم وظائف أعلى'
        // PDFKit mirrors literal parentheses in this otherwise visual RTL run.
        // Pre-mirror this one raw token so its physical glyphs read (ندب).
        : 'بيان بموقف الوظائف التى يمكن شغلها )ندب( بالمستوى الأول فأقل',
      30,
      66,
      contentWidth,
      'center'
    )
    if (!isPromotion && snapshot.routingUnit?.nameAr) {
      doc.font('Arabic').fontSize(9).fillColor(ink)
      drawPreparedText(snapshot.routingUnit.nameAr, 30, 83, contentWidth, 'center')
    }
    doc.font('Arabic').fontSize(8).fillColor(muted)
    drawPreparedText('السنة:', 30, 101, 42, 'right')
    drawPreparedText(String(snapshot.cycleYear ?? '—'), 76, 101, 104, 'left')
    drawPreparedText('النيابة:', 180, 101, 48, 'right')
    drawPreparedText(snapshot.routingUnit?.nameAr ?? '—', 232, 101, 292, 'center')
    drawPreparedText('رقم الطلب:', 530, 101, 58, 'right')
    drawPreparedText(snapshot.requestNumber, 592, 101, contentWidth - 562, 'left')

    // Table
    const startY = 120
    let currentY = startY

    const promotionWidthScale = contentWidth / 779
    const promotionWidths = {
      no: 20 * promotionWidthScale, personnel: 50 * promotionWidthScale, name: 70 * promotionWidthScale, qualification: 115 * promotionWidthScale, currentJob: 75 * promotionWidthScale, department: 70 * promotionWidthScale,
      currentJobDate: 50 * promotionWidthScale, day: 20 * promotionWidthScale, month: 20 * promotionWidthScale, year: 20 * promotionWidthScale, nomination: 22 * promotionWidthScale, defer: 22 * promotionWidthScale,
      nominatedJob: 100 * promotionWidthScale, performance: 55 * promotionWidthScale, notes: 70 * promotionWidthScale
    }
    const secondmentWidthScale = contentWidth / 778
    const secondmentWidths = { no: 22 * secondmentWidthScale, name: 88 * secondmentWidthScale, job: 85 * secondmentWidthScale, qualification: 95 * secondmentWidthScale, report: 75 * secondmentWidthScale, option: 170 * secondmentWidthScale, dependency: 130 * secondmentWidthScale, status: 75 * secondmentWidthScale, notes: 38 * secondmentWidthScale }

    const drawHeader = () => {
      const headerFontSize = 7.2
      const headerPadding = 8
      const xForColumn = (index: number) => 30 + contentWidth - headers.slice(0, index + 1).reduce((total, header) => total + header.w, 0)
      const drawHeaderLabel = (label: string, x: number, y: number, width: number) => {
        doc.font('ArabicBold').fontSize(headerFontSize).fillColor(green)
        drawPreparedText(label, x + 3, y + 4, width - 6, 'right')
      }
      if (isPromotion) {
        const firstTier = Math.max(
          25,
          ...[...headers.slice(0, 7), headers[12]!, headers[13]!, headers[14]!].map(header => {
            doc.font('ArabicBold').fontSize(headerFontSize)
            return preparedTextHeight(header.label, header.w - 6) + headerPadding
          }),
          preparedTextHeight('مدة الخبرة', headers.slice(7, 10).reduce((total, header) => total + header.w, 0) - 6) + headerPadding,
          preparedTextHeight('التوصية', headers.slice(10, 12).reduce((total, header) => total + header.w, 0) - 6) + headerPadding
        )
        const secondTier = Math.max(20, ...headers.slice(7, 12).map(header => {
          doc.font('ArabicBold').fontSize(headerFontSize)
          return preparedTextHeight(header.label, header.w - 6) + headerPadding
        }))
        const totalHeight = firstTier + secondTier
        doc.save().rect(30, currentY, contentWidth, totalHeight).fill(pale).strokeColor(border).stroke().restore()
        for (const index of [0, 1, 2, 3, 4, 5, 6, 12, 13, 14]) {
          const header = headers[index]!
          const x = xForColumn(index)
          doc.save().rect(x, currentY, header.w, totalHeight).strokeColor(border).stroke().restore()
          drawHeaderLabel(header.label, x, currentY, header.w)
        }
        for (const [start, end, label] of [[7, 9, 'مدة الخبرة'], [10, 11, 'التوصية']] as const) {
          const x = xForColumn(end)
          const width = headers.slice(start, end + 1).reduce((total, header) => total + header.w, 0)
          doc.save().rect(x, currentY, width, firstTier).strokeColor(border).stroke().restore()
          drawHeaderLabel(label, x, currentY, width)
        }
        for (let index = 7; index <= 11; index += 1) {
          const header = headers[index]!
          const x = xForColumn(index)
          doc.save().rect(x, currentY + firstTier, header.w, secondTier).strokeColor(border).stroke().restore()
          drawHeaderLabel(header.label, x, currentY + firstTier, header.w)
        }
        currentY += totalHeight
        return
      }
      const headerHeight = Math.max(
        28,
        ...headers.map(header => {
          doc.font('ArabicBold').fontSize(headerFontSize)
          return preparedTextHeight(header.label, header.w - 6) + headerPadding
        })
      )
      doc.save().rect(30, currentY, contentWidth, headerHeight).fill(pale).strokeColor(border).stroke().restore()
      doc.font('ArabicBold').fontSize(headerFontSize).fillColor(green)
      let usedWidth = 0
      for (const h of headers) {
        const headerX = 30 + contentWidth - usedWidth - h.w
        doc.save().rect(headerX, currentY, h.w, headerHeight).strokeColor(border).stroke().restore()
        drawPreparedText(h.label, headerX + 3, currentY + 4, h.w - 6, 'right')
        usedWidth += h.w
      }
      currentY += headerHeight
    }

    const headers: RenderHeaderCell[] = isPromotion
      ? [
          { label: 'م', w: promotionWidths.no },
          { label: 'رقم العامل', w: promotionWidths.personnel },
          { label: 'اسم المرشح', w: promotionWidths.name },
          { label: 'المؤهل الدراسي وتاريخه', w: promotionWidths.qualification },
          { label: 'الوظيفة الحالية', w: promotionWidths.currentJob },
          { label: 'الإدارة العامة', w: promotionWidths.department },
          { label: 'تاريخ شغلها', w: promotionWidths.currentJobDate },
          { label: 'يوم', w: promotionWidths.day },
          { label: 'شهر', w: promotionWidths.month },
          { label: 'سنة', w: promotionWidths.year },
          { label: 'ترشيح', w: promotionWidths.nomination },
          { label: 'تأجيل', w: promotionWidths.defer },
          { label: 'الوظيفة المرشح لشغلها', w: promotionWidths.nominatedJob },
          { label: 'آخر تقرير كفاية سنوي', w: promotionWidths.performance },
          { label: 'ملاحظات', w: promotionWidths.notes }
        ]
      : [
          { label: 'م', w: secondmentWidths.no },
          { label: 'اسم المرشح', w: secondmentWidths.name },
          { label: 'الوظيفة الحالية', w: secondmentWidths.job },
          { label: 'المؤهل الدراسي وتاريخه', w: secondmentWidths.qualification },
          { label: 'تقرير آخر ترقية', w: secondmentWidths.report },
          { label: 'الوظائف الشاغرة والتي يجوز الندب لشغلها', w: secondmentWidths.option },
          { label: 'التبعية التنظيمية', w: secondmentWidths.dependency },
          { label: 'استيفاء / عدم استيفاء مطالب تأهيل شغل الوظيفة', w: secondmentWidths.status },
          { label: 'ملاحظات', w: secondmentWidths.notes }
        ]

    drawHeader()

    const measureRow = (rowValues: RenderValueCell[]) => Math.max(24, ...rowValues.map(cell => {
      doc.font('Arabic').fontSize(7.4)
      return (cell.val === '' ? 0 : preparedTextHeight(cell.val, cell.w - 6)) + 10
    }))

    const drawRow = (rowValues: RenderValueCell[], measuredHeight?: number) => {
      const rowHeight = measuredHeight ?? measureRow(rowValues)
      if (currentY + rowHeight > doc.page.height - 180) {
        doc.addPage()
        currentY = 40
        drawHeader()
      }
      let usedWidth = 0
      for (const cell of rowValues) {
        const rowX = 30 + contentWidth - usedWidth - cell.w
        doc.save().rect(rowX, currentY, cell.w, rowHeight).strokeColor(border).stroke().restore()
        doc.font('Arabic').fontSize(7.4).fillColor(ink)
        if (cell.val !== '') drawPreparedText(cell.val, rowX + 3, currentY + 5, cell.w - 6, 'right')
        usedWidth += cell.w
      }
      currentY += rowHeight
    }

    if (isPromotion) {
      snapshot.candidates.forEach((c, idx) => {
        const recommendation = c.promotionDecision?.recommendation
        const rowValues: RenderValueCell[] = [
          { val: String(idx + 1), w: promotionWidths.no },
          { val: c.personnelNumber, w: promotionWidths.personnel },
          { val: c.employeeName, w: promotionWidths.name },
          { val: `${c.qualificationInstitute ?? '—'} | ${c.qualificationName ?? '—'}\n${c.qualificationDate ?? '—'}`, w: promotionWidths.qualification },
          { val: c.currentJobTitle, w: promotionWidths.currentJob },
          { val: c.sourceRoutingLabel ?? '—', w: promotionWidths.department },
          { val: c.currentJobStartDate ?? '—', w: promotionWidths.currentJobDate },
          { val: c.experience.days ?? '—', w: promotionWidths.day },
          { val: c.experience.months ?? '—', w: promotionWidths.month },
          { val: c.experience.years ?? '—', w: promotionWidths.year },
          { val: recommendation === 'ترشيح' ? '✓' : '—', w: promotionWidths.nomination },
          { val: recommendation === 'تأجيل' ? '✓' : '—', w: promotionWidths.defer },
          { val: c.promotionDecision?.effectiveNominatedJob ?? '—', w: promotionWidths.nominatedJob },
          { val: c.performanceRating ?? '—', w: promotionWidths.performance },
          { val: c.promotionDecision?.notes ?? '—', w: promotionWidths.notes }
        ]
        const rowHeight = measureRow(rowValues)
        drawRow(rowValues, rowHeight)
      })
    } else {
      let previousCategoryCode: string | null = null
      let categorySerial = 0
      snapshot.candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) =>
          (left.candidate.secondmentPreparation?.jobCategoryCode ?? '').localeCompare(right.candidate.secondmentPreparation?.jobCategoryCode ?? '')
          || left.index - right.index
        )
        .forEach(({ candidate: c }) => {
        const options = c.secondmentPositionOptions ?? []
        const firstOption = options[0]
        const preparation = c.secondmentPreparation
        const categoryChanged = preparation?.jobCategoryCode !== previousCategoryCode
        const candidateSerial = categoryChanged ? 1 : categorySerial + 1
        const notes = c.candidateNotes?.join('\n') || '—'
        const qualification = `${c.qualificationInstitute ?? '—'} | ${c.qualificationName ?? '—'}\n${c.qualificationDate ?? '—'}`
        const qualificationDisplay = (option: NonNullable<typeof firstOption>) => option.qualificationStatusName
          ?? (option.qualificationStatus === 'QUALIFIED' ? 'مستوفي' : option.qualificationStatus === 'NOT_QUALIFIED' ? 'غير مستوفي' : option.qualificationStatus)
        const firstRow: RenderValueCell[] = [
          { val: String(candidateSerial), w: secondmentWidths.no }, { val: c.employeeName, w: secondmentWidths.name },
          { val: c.currentJobTitle, w: secondmentWidths.job }, { val: qualification, w: secondmentWidths.qualification },
          { val: preparation?.lastPromotionReport ?? '—', w: secondmentWidths.report }, { val: firstOption ? `${firstOption.optionId === c.secondmentSelection?.selectedOptionId ? '✓ المختارة: ' : ''}${firstOption.positionTitle}` : '—', w: secondmentWidths.option },
          { val: firstOption?.organizationalDependency ?? '—', w: secondmentWidths.dependency }, { val: firstOption ? qualificationDisplay(firstOption) : '—', w: secondmentWidths.status }, { val: notes, w: secondmentWidths.notes }
        ]
        if (categoryChanged) {
          categorySerial = 0
          if (currentY + 20 + measureRow(firstRow) > doc.page.height - 180) {
            doc.addPage()
            currentY = 40
            drawHeader()
          }
          doc.save().rect(30, currentY, contentWidth, 20).fill('#d9d9d9').strokeColor(border).stroke().restore()
          doc.font('ArabicBold').fontSize(8).fillColor(green)
          drawPreparedText(preparation?.jobCategoryName ?? '—', 36, currentY + 5, contentWidth - 12, 'right')
          currentY += 20
          previousCategoryCode = preparation?.jobCategoryCode ?? null
        }
        categorySerial = candidateSerial
        if (!options.length) {
          drawRow(firstRow)
          return
        }
        options.forEach((option, optionIndex) => {
          const selected = option.optionId === c.secondmentSelection?.selectedOptionId
          drawRow([
            { val: optionIndex === 0 ? String(candidateSerial) : '', w: secondmentWidths.no },
            { val: optionIndex === 0 ? c.employeeName : '', w: secondmentWidths.name },
            { val: optionIndex === 0 ? c.currentJobTitle : '', w: secondmentWidths.job },
            { val: optionIndex === 0 ? qualification : '', w: secondmentWidths.qualification },
            { val: optionIndex === 0 ? preparation?.lastPromotionReport ?? '—' : '', w: secondmentWidths.report },
            { val: `${selected ? '✓ المختارة: ' : ''}${option.positionTitle}`, w: secondmentWidths.option },
            { val: option.organizationalDependency, w: secondmentWidths.dependency },
            { val: qualificationDisplay(option), w: secondmentWidths.status },
            { val: optionIndex === 0 ? notes : '', w: secondmentWidths.notes }
          ])
        })
        })
    }

    // Signers Block (3 Signers: Right = HR, Center = ORG, Left = AUTH)
    const footerHeight = 118
    const footerGap = 20
    if (currentY + footerGap + footerHeight > doc.page.height - 30) {
      doc.addPage()
      currentY = 40
    } else {
      currentY += footerGap
    }

    const colW = (contentWidth - 40) / 3
    const signoffHr = snapshot.signoffs.find(s => ['P1', 'S1'].includes(s.stageCode))
    const signoffOrg = snapshot.signoffs.find(s => ['P2', 'S2'].includes(s.stageCode))
    const signoffAuth = snapshot.signoffs.find(s => ['P4', 'S3'].includes(s.stageCode))

    const signBlocks = [
      { signoff: signoffHr, x: 30 + 2 * (colW + 20) }, // Right
      { signoff: signoffOrg, x: 30 + (colW + 20) },     // Center
      { signoff: signoffAuth, x: 30 } // Left
    ]

    for (const b of signBlocks) {
      if (b.signoff) {
        doc.font('Arabic').fontSize(7.8).fillColor(muted)
        drawPreparedText(b.signoff.signerJobTitle, b.x + 4, currentY, colW - 8, 'center')
        doc.font('ArabicBold').fontSize(8).fillColor(ink)
        drawPreparedText(b.signoff.signerName, b.x + 4, currentY + 17, colW - 8, 'center')

        const imgBuffer = signatureImages.get(b.signoff.signatureAssetId)
        if (imgBuffer) {
          try {
            doc.image(imgBuffer, b.x + (colW - 90) / 2, currentY + 37, { fit: [90, 30], align: 'center', valign: 'center' })
          } catch {
            // image fallback
          }
        }

      } else {
        doc.font('Arabic').fontSize(8).fillColor(muted)
          .text(visual('لم يسجل توقيع معتمد'), b.x + 4, currentY + 45, { width: colW - 8, align: 'center' })
      }
    }

    doc.end()
  })
}

export function renderAuditTrailPdf(
  entries: AuditPdfEntry[],
  requestNumber: string,
  maxOutputBytes: number
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, right: 40, bottom: 40, left: 40 },
      bufferPages: true,
      compress: true,
      info: {
        Title: `سجل التدقيق — ${requestNumber}`,
        Author: 'EGAS',
        Creator: 'EGAS Promotion & Secondment System v5'
      }
    })

    doc.registerFont('Arabic', regularFont)
    doc.registerFont('ArabicBold', boldFont)
    doc.font('Arabic')

    const chunks: Buffer[] = []
    let totalBytes = 0
    let exceeded = false

    doc.on('data', chunk => {
      totalBytes += chunk.length
      if (totalBytes > maxOutputBytes) {
        exceeded = true
        return
      }
      if (!exceeded) chunks.push(chunk)
    })

    doc.once('error', reject)
    doc.once('end', () => {
      if (exceeded) {
        reject(new Error('PDF output limit exceeded'))
      } else {
        resolve(Buffer.concat(chunks))
      }
    })

    const contentWidth = doc.page.width - 80

    doc.font('ArabicBold').fontSize(14).fillColor(green)
      .text(visual(`سجل التدقيق والتتبع — طلب رقم: ${requestNumber}`), 40, 40, { width: contentWidth, align: 'center' })

    let currentY = 70

    entries.forEach((e, index) => {
      if (currentY > doc.page.height - 80) {
        doc.addPage()
        currentY = 40
      }

      doc.save().roundedRect(40, currentY, contentWidth, 42, 3).strokeColor(border).stroke().restore()
      doc.font('ArabicBold').fontSize(8.5).fillColor(green)
        .text(visual(`#${index + 1} [${e.actionType}] - مرحلة: ${e.stageCode ?? '—'} (تكرار ${e.iterationNo})`), 48, currentY + 5, { width: contentWidth - 16, align: 'right' })

      doc.font('Arabic').fontSize(8).fillColor(ink)
        .text(visual(`القائم بالإجراء: ${e.actorName ?? e.actorUsername ?? 'النظام'} | التاريخ: ${arabicDate(e.createdAt)}`), 48, currentY + 18, { width: contentWidth - 16, align: 'right' })

      if (e.reason) {
        doc.font('Arabic').fontSize(7.5).fillColor(muted)
          .text(visual(`السبب: ${e.reason}`), 48, currentY + 29, { width: contentWidth - 16, align: 'right' })
      }

      currentY += 48
    })

    doc.end()
  })
}

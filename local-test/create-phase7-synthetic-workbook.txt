import ExcelJS from 'exceljs'
import path from 'node:path'
const repoRoot = process.cwd()
const output = path.join(repoRoot, 'local-test', 'EGAS_2026_SYNTHETIC_VALID.xlsx')

const headers = [
  'م',
  'رقم الموظف',
  'اسم الموظف',
  'مجموعة الموظفين',
  'المجموعة الفرعية',
  'النيابة / المساعد',
  'الوظيفة',
  'تاريخ اقدمية أخر ترقية',
  'تاريخ بداية الخبرة',
  'تقرير كفاية 2026',
  'تاريخ الالتحاق',
  '0000 /عدد سنوات الخبرة حتى 1/1',
  '0000 \\عدد الشهور حتى 1\\1',
  '0000 \\عدد الايام حتى 1\\1',
  '0000 \\عدد السنوات حتى 1\\7',
  '0000 \\عددالشهور حتى 1\\7',
  '0000 \\عدداالايام حتى 1\\7',
  'المؤسسة التعليمية-المؤهل الاصلي',
  'الشهادة-المؤهل الاصلي',
  'تاريخ المؤهل الاصلي',
  'بداية شغل الوظيفة'
]

const routingUnits = [
  'نظم المعلومات والاتصالات',
  'الشئون المالية',
  'التخطيط ومشروعات الغاز وتنمية الاعمال',
  'الشئون القانونية'
]

const people = [
  ['900101','أحمد سامح إبراهيم محمود',routingUnits[0],'مدير إدارة تطوير التطبيقات','2008-07-01','2009-01-15','2021-07-01','ممتاز','بكالوريوس حاسبات ومعلومات','نظم معلومات','2008-06-15'],
  ['900102','منى خالد عبد العزيز حسن',routingUnits[0],'رئيس قسم أمن المعلومات','2011-07-01','2011-09-01','2022-07-01','جيد جدا','بكالوريوس حاسبات ومعلومات','علوم الحاسب','2011-06-20'],
  ['900103','يوسف علي محمد سالم',routingUnits[0],'أخصائي أول قواعد البيانات','2014-07-01','2014-10-01','2023-07-01','جيد','بكالوريوس حاسبات ومعلومات','نظم معلومات','2014-06-18'],
  ['900104','سلمى حسن محمود عبد الله',routingUnits[0],'رئيس قسم الدعم الفني','2010-07-01','2010-09-15','2020-07-01','جيد جدا','بكالوريوس هندسة','اتصالات وحاسبات','2010-06-25'],
  ['900105','كريم طارق أحمد منصور',routingUnits[0],'أخصائي نظم وشبكات','2013-07-01','2013-10-15','2022-01-01','ممتاز','بكالوريوس هندسة','اتصالات وإلكترونيات','2013-06-22'],
  ['900106','هبة عمر سعيد فؤاد',routingUnits[0],'محلل نظم أول','2015-07-01','2015-09-01','2024-01-01','جيد','بكالوريوس حاسبات ومعلومات','تكنولوجيا المعلومات','2015-06-16'],

  ['900201','محمد عبد الرحمن سيد أحمد',routingUnits[1],'مدير إدارة الحسابات العامة','2007-07-01','2007-10-01','2020-07-01','ممتاز','بكالوريوس تجارة','محاسبة','2007-06-20'],
  ['900202','نورهان محمود عبد الحميد علي',routingUnits[1],'رئيس قسم الموازنات','2010-07-01','2010-09-01','2021-07-01','جيد جدا','بكالوريوس تجارة','محاسبة','2010-06-18'],
  ['900203','شريف عادل إبراهيم حسن',routingUnits[1],'أخصائي مالي أول','2012-07-01','2012-10-01','2022-07-01','جيد','بكالوريوس تجارة','إدارة مالية','2012-06-20'],
  ['900204','دينا أشرف محمد سالم',routingUnits[1],'رئيس قسم التكاليف','2009-07-01','2009-09-15','2021-01-01','ممتاز','بكالوريوس تجارة','محاسبة','2009-06-17'],
  ['900205','محمود أيمن فوزي حسن',routingUnits[1],'أخصائي ضرائب أول','2014-07-01','2014-10-01','2023-07-01','جيد جدا','بكالوريوس تجارة','محاسبة','2014-06-21'],
  ['900206','آية فؤاد سمير محمود',routingUnits[1],'محلل مالي','2016-07-01','2016-09-01','2024-07-01','جيد','بكالوريوس تجارة','اقتصاد','2016-06-19'],

  ['900301','خالد حسن علي إبراهيم',routingUnits[2],'مدير إدارة التخطيط الاستراتيجي','2006-07-01','2006-10-01','2020-07-01','ممتاز','بكالوريوس هندسة','بترول','2006-06-24'],
  ['900302','مريم أشرف عبد الله محمود',routingUnits[2],'رئيس قسم دراسات الجدوى','2010-07-01','2010-09-01','2021-07-01','جيد جدا','بكالوريوس اقتصاد وعلوم سياسية','اقتصاد','2010-06-22'],
  ['900303','عمر نبيل محمد فؤاد',routingUnits[2],'أخصائي تخطيط أول','2012-07-01','2012-10-01','2022-07-01','جيد','بكالوريوس هندسة','بترول','2012-06-23'],
  ['900304','يارا سامي حسن أحمد',routingUnits[2],'محلل مشروعات أول','2013-07-01','2013-09-01','2023-01-01','ممتاز','بكالوريوس هندسة','مدني وإدارة مشروعات','2013-06-20'],
  ['900305','حسام رامي عبد العزيز سالم',routingUnits[2],'أخصائي اقتصاديات الطاقة','2015-07-01','2015-10-01','2024-01-01','جيد جدا','بكالوريوس تجارة','اقتصاد','2015-06-18'],
  ['900306','نهى علي محمود فؤاد',routingUnits[2],'رئيس قسم متابعة المشروعات','2009-07-01','2009-09-15','2021-07-01','جيد','بكالوريوس هندسة','إدارة مشروعات','2009-06-25'],

  ['900401','وليد فؤاد عبد الرحمن محمود',routingUnits[3],'مدير إدارة العقود القانونية','2005-07-01','2005-10-01','2019-07-01','ممتاز','ليسانس حقوق','قانون','2005-06-20'],
  ['900402','بسمة خالد حسن إبراهيم',routingUnits[3],'رئيس قسم التحقيقات','2009-07-01','2009-09-01','2021-07-01','جيد جدا','ليسانس حقوق','قانون','2009-06-22'],
  ['900403','أحمد علاء محمود سالم',routingUnits[3],'محام أول','2012-07-01','2012-10-01','2022-07-01','جيد','ليسانس حقوق','قانون','2012-06-18'],
  ['900404','مها سعيد أحمد فؤاد',routingUnits[3],'أخصائي قانوني أول','2014-07-01','2014-09-01','2023-07-01','ممتاز','ليسانس حقوق','قانون','2014-06-20'],
  ['900405','كريم جمال عبد الحميد حسن',routingUnits[3],'رئيس قسم القضايا','2008-07-01','2008-10-01','2020-07-01','جيد جدا','ليسانس حقوق','قانون','2008-06-21'],
  ['900406','رانيا سمير محمد علي',routingUnits[3],'باحث قانوني أول','2016-07-01','2016-09-01','2024-07-01','جيد','ليسانس حقوق','قانون','2016-06-19']
]

function utcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function daysInMonthUTC(year, month1Based) {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate()
}

function diffYmd(start, end) {
  let years = end.getUTCFullYear() - start.getUTCFullYear()
  let months = end.getUTCMonth() - start.getUTCMonth()
  let days = end.getUTCDate() - start.getUTCDate()

  if (days < 0) {
    months -= 1
    let prevMonth = end.getUTCMonth() // 0 => previous month is Dec previous year
    let prevYear = end.getUTCFullYear()
    if (prevMonth === 0) {
      prevMonth = 12
      prevYear -= 1
    }
    days += daysInMonthUTC(prevYear, prevMonth)
  }

  if (months < 0) {
    years -= 1
    months += 12
  }

  return [Math.max(0, years), Math.max(0, months), Math.max(0, days)]
}

const expRef = utcDate('2026-01-01')
const tenureRef = utcDate('2026-07-01')

const workbook = new ExcelJS.Workbook()
workbook.creator = 'EGAS Phase 7 synthetic local test'
workbook.created = new Date()
workbook.modified = new Date()
workbook.calcProperties.fullCalcOnLoad = false

const dataSheet = workbook.addWorksheet('البيانات الاساسية', {
  views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }]
})
const routingSheet = workbook.addWorksheet('نيابة مساعد', {
  views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }]
})

dataSheet.addRow(headers)

for (let index = 0; index < people.length; index += 1) {
  const [
    personnelNumber, employeeName, routingUnit, currentJobTitle,
    experienceStartIso, joiningIso, currentJobStartIso, performance,
    qualificationSource1, qualificationSource2, qualificationDateIso
  ] = people[index]

  const experienceStart = utcDate(experienceStartIso)
  const joiningDate = utcDate(joiningIso)
  const currentJobStart = utcDate(currentJobStartIso)
  const qualificationDate = utcDate(qualificationDateIso)

  const [expYears, expMonths, expDays] = diffYmd(experienceStart, expRef)
  const [jobYears, jobMonths, jobDays] = diffYmd(currentJobStart, tenureRef)

  // Synthetic last-promotion seniority is aligned to start of current job.
  const lastPromotionDate = currentJobStart

  dataSheet.addRow([
    index + 1,
    personnelNumber,
    employeeName,
    'معينين',
    'مستوى اول',
    routingUnit,
    currentJobTitle,
    lastPromotionDate,
    experienceStart,
    performance,
    joiningDate,
    String(expYears).padStart(2, '0'),
    String(expMonths).padStart(2, '0'),
    String(expDays).padStart(2, '0'),
    String(jobYears).padStart(2, '0'),
    String(jobMonths).padStart(2, '0'),
    String(jobDays).padStart(2, '0'),
    qualificationSource1,
    qualificationSource2,
    qualificationDate,
    currentJobStart
  ])
}

routingSheet.addRow(['النيابة / المساعد'])
for (const unit of routingUnits) routingSheet.addRow([unit])

const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6B3A' } }
const headerFont = { bold: true, color: { argb: 'FFFFFFFF' } }

for (const sheet of [dataSheet, routingSheet]) {
  sheet.getRow(1).fill = headerFill
  sheet.getRow(1).font = headerFont
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
}

dataSheet.getRow(1).height = 42
dataSheet.eachRow((row, rowNumber) => {
  if (rowNumber > 1) {
    row.height = 28
    row.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }
  }
})

for (const col of [8, 9, 11, 20, 21]) {
  dataSheet.getColumn(col).numFmt = 'yyyy-mm-dd'
}

const widths = [7,14,30,13,14,32,38,18,18,16,18,16,16,16,16,16,16,28,28,18,18]
widths.forEach((width, index) => { dataSheet.getColumn(index + 1).width = width })
routingSheet.getColumn(1).width = 42

await workbook.xlsx.writeFile(output)

console.log(`Created ${output}`)
console.log(`Synthetic employee rows: ${people.length}`)
console.log(`Routing reference rows: ${routingUnits.length}`)

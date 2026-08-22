import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ExcelJS from 'exceljs'
import { workbookDirectory } from './local-dev-lib.mjs'

export const DEV_WORKBOOK_HEADERS = year => [
  'م', 'رقم الموظف', 'اسم الموظف', 'مجموعة الموظفين', 'المجموعة الفرعية',
  'النيابة / المساعد', 'الوظيفة', 'تاريخ اقدمية أخر ترقية', 'تاريخ بداية الخبرة',
  `تقرير كفاية ${year}`, 'تاريخ الالتحاق', `عدد سنوات الخبرة حتى 1/1/${year}`,
  `عدد شهور الخبرة حتى 1/1/${year}`, `عدد ايام الخبرة حتى 1/1/${year}`,
  `عدد سنوات حتى 1/7/${year}`, `عدد شهور حتى 1/7/${year}`, `عدد ايام حتى 1/7/${year}`,
  'المؤسسة التعليمية-المؤهل الاصلي', 'الشهادة-المؤهل الاصلي',
  'تاريخ المؤهل الاصلي', 'بداية شغل الوظيفة'
]

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day))
}

export async function generateDevWorkbook(file, year, routingUnits, employees) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('Synthetic snapshot year is invalid')
  if (!Array.isArray(routingUnits) || routingUnits.length < 2) throw new Error('At least two routing units are required')
  if (!Array.isArray(employees) || employees.length < routingUnits.length) throw new Error('Synthetic employees are incomplete')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'EGAS synthetic local development generator'
  workbook.created = utcDate(year, 1, 1)
  workbook.modified = utcDate(year, 1, 1)
  const data = workbook.addWorksheet('البيانات الاساسية', { views: [{ rightToLeft: true }] })
  data.addRow(DEV_WORKBOOK_HEADERS(year))
  data.getRow(1).font = { bold: true }

  const experienceStartYear = Math.max(2000, year - 12)
  const jobStartYear = Math.max(experienceStartYear + 2, year - 5)
  const ratings = ['ممتاز', 'جيد جدا', 'جيد']
  employees.forEach((employee, index) => {
    data.addRow([
      index + 1,
      employee.personnelNumber,
      employee.name,
      'دائم',
      employee.subgroup ?? 'تخصصي',
      employee.routingName,
      employee.jobTitle,
      utcDate(jobStartYear, 1, 1),
      utcDate(experienceStartYear, 1, 1),
      ratings[index % ratings.length],
      utcDate(experienceStartYear, 3, 1),
      year - experienceStartYear,
      0,
      0,
      year - jobStartYear,
      0,
      0,
      'جامعة مصرية تجريبية',
      'مؤهل جامعي تجريبي',
      utcDate(experienceStartYear - 1, 6, 1),
      utcDate(jobStartYear, 7, 1)
    ])
  })

  const routing = workbook.addWorksheet('نيابة مساعد', { views: [{ rightToLeft: true }] })
  routing.addRow(['النيابة / المساعد'])
  for (const unit of routingUnits) routing.addRow([unit.nameAr])

  await mkdir(path.dirname(file), { recursive: true })
  await workbook.xlsx.writeFile(file)
  return file
}

async function main() {
  const year = Number(process.argv[2] ?? new Date().getUTCFullYear())
  const file = process.argv[3] ?? path.join(workbookDirectory, `egas-synthetic-${year}.xlsx`)
  await generateDevWorkbook(file, year,
    [{ nameAr: 'نيابة القاهرة' }, { nameAr: 'نيابة الإسكندرية' }],
    [
      { personnelNumber: 'DEV1001', name: 'موظف القاهرة التجريبي', routingName: 'نيابة القاهرة', jobTitle: 'أخصائي تجريبي' },
      { personnelNumber: 'DEV2001', name: 'موظف الإسكندرية التجريبي', routingName: 'نيابة الإسكندرية', jobTitle: 'مهندس تجريبي' }
    ])
  console.info(`Synthetic workbook written to ${file}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}


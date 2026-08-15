import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cds from '@sap/cds'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const test = cds.test(projectRoot)
const basicAuth = {
  username: 'foundation-ea',
  password: 'synthetic-only'
}

describe('CAP backend foundation', () => {
  it('starts the CAP application and answers liveness/readiness', async () => {
    const live = await test.get('/health/liveness()')
    expect(live.status).toBe(200)
    expect(live.data.value).toBe('ok')

    const ready = await test.get('/health/readiness()')
    expect(ready.status).toBe(200)
    expect(ready.data.value).toBe('ready')
  })

  it('configures PostgreSQL for production without committed credentials', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      cds: {
        requires: {
          db: {
            kind: string
            credentials?: unknown
          }
        }
      }
    }
    const databaseConfiguration = packageJson.cds.requires.db

    expect(databaseConfiguration.kind).toBe('postgres')
    expect(databaseConfiguration.credentials).toBeUndefined()
  })

  it('compiles all required logical entities and relationships', async () => {
    const model = await cds.load(path.join(projectRoot, 'db/model.cds'))
    const definitions = model.definitions ?? {}
    const required = [
      'RoutingUnit',
      'RoutingUnitSourceAlias',
      'JobCategoryReference',
      'QualificationStatusReference',
      'UserAccount',
      'UserAccountRole',
      'AuthSession',
      'AuthLoginAttempt',
      'SecurityEvent',
      'ImportBatch',
      'EmployeeImportStagingRow',
      'Employee',
      'EmployeeAnnualSnapshot',
      'ApprovingAuthorityAssignment',
      'AuthorityDelegation',
      'UserSignatureAsset',
      'WorkflowRequest',
      'RequestFormSection',
      'RequestCandidate',
      'WorkflowIteration',
      'StageTask',
      'StageReceivedSnapshot',
      'SecondmentPositionOption',
      'PromotionDecision',
      'StageAction',
      'WorkflowNote',
      'WorkflowSignoff',
      'Notification',
      'AuditEvent',
      'PdfGenerationLog'
    ]

    for (const name of required) {
      expect(definitions[`egas.${name}`], `missing egas.${name}`).toBeDefined()
    }

    const request = definitions['egas.WorkflowRequest']
    const candidate = definitions['egas.RequestCandidate']
    const received = definitions['egas.StageReceivedSnapshot']
    expect(request?.elements?.routingUnit?.target).toBe('egas.RoutingUnit')
    expect(request?.elements?.approvingAuthorityAssignment?.target)
      .toBe('egas.ApprovingAuthorityAssignment')
    expect(candidate?.elements?.employeeSnapshot?.target).toBe('egas.EmployeeAnnualSnapshot')
    expect(received?.elements?.stageTask?.target).toBe('egas.StageTask')
  })

  it('loads the fixed reference seed data', async () => {
    const response = await test.get('/reference/RoutingUnits?$count=true&$orderby=nameAr', {
      auth: basicAuth
    })
    expect(response.status).toBe(200)
    expect(response.data.value).toHaveLength(22)
    expect(response.data['@odata.count']).toBe(22)

    const categories = await test.get('/reference/JobCategories?$orderby=displayOrder', {
      auth: basicAuth
    })
    expect(categories.data.value.map((row: { code: string }) => row.code)).toEqual([
      'MANAGER_DEPARTMENT',
      'SECTION_HEAD',
      'STANDARD_FIRST',
      'STANDARD_EXCELLENT',
      'STANDARD_SKILLED'
    ])
  })

  it('does not expose WorkflowRequest status through generic CRUD', async () => {
    const model = await cds.load(path.join(projectRoot, 'srv/workflow-service.cds'))
    const definitions = model.definitions ?? {}
    const workflowService = definitions.WorkflowService
    expect(workflowService?.kind).toBe('service')

    const exposedTargets = Object.values(definitions)
      .filter(definition => definition.kind === 'entity')
      .map(definition => definition.query?.SELECT?.from?.ref?.[0])
    expect(exposedTargets).not.toContain('egas.WorkflowRequest')

    const response = await test.patch(
      "/workflow-foundation/Requests(00000000-0000-4000-8000-000000000001)",
      { status: 'COMPLETED' },
      { auth: basicAuth, validateStatus: () => true }
    )
    expect([404, 405]).toContain(response.status)
  })

  it('keeps repository seed fixtures free of users and employee records', async () => {
    const seedDirectory = path.join(projectRoot, 'db/data')
    const files = (await readdir(seedDirectory)).sort()
    expect(files).toEqual([
      'egas-JobCategoryReference.csv',
      'egas-QualificationStatusReference.csv',
      'egas-RoutingUnit.csv'
    ])

    const content = (await Promise.all(
      files.map(file => readFile(path.join(seedDirectory, file), 'utf8'))
    )).join('\n')
    expect(content).not.toMatch(/passwordHash|personnelNumber|staffIdentifier|UserAccount/)
  })
})

import cds from '@sap/cds'

export default class EmployeeDataService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'local-annual-snapshot-provider-boundary-ready')
    await super.init()
  }
}

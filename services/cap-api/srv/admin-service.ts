import cds from '@sap/cds'

export default class AdminService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'admin-boundary-ready')
    await super.init()
  }
}

import cds from '@sap/cds'

export default class AuditService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'append-only-audit-boundary-ready')
    await super.init()
  }
}

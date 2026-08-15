import cds from '@sap/cds'

export default class WorkflowService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'explicit-actions-only')
    await super.init()
  }
}

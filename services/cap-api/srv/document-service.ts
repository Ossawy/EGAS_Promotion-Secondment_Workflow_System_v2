import cds from '@sap/cds'

export default class DocumentService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'document-boundary-ready-renderer-not-enabled')
    await super.init()
  }
}

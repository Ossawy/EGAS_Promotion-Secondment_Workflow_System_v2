import cds from '@sap/cds'

export default class AuthService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('foundationStatus', () => 'local-auth-provider-boundary-ready')
    await super.init()
  }
}

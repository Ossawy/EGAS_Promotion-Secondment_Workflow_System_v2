import cds from '@sap/cds'

export default class HealthService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('liveness', () => 'ok')
    this.on('readiness', async () => {
      const db = await cds.connect.to('db')
      await db.run(SELECT.one.from('egas.RoutingUnit').columns('ID'))
      return 'ready'
    })
    await super.init()
  }
}

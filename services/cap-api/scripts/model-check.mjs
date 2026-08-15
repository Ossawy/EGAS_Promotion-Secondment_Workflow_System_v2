import cds from '@sap/cds'

const model = await cds.load('db/model.cds')
const entityCount = Object.values(model.definitions)
  .filter(definition => definition.kind === 'entity')
  .length

console.info(`CDS model compiled successfully (${entityCount} entities).`)

import { readFile, writeFile } from 'node:fs/promises'

const generatedPackage = new URL('../gen/srv/package.json', import.meta.url)
const sourceImpl = 'srv/auth/local-auth-middleware.ts'
const compiledImpl = 'srv/auth/local-auth-middleware.js'
const packageJson = JSON.parse(await readFile(generatedPackage, 'utf8'))
const auth = packageJson?.cds?.requires?.auth

if (packageJson.scripts?.start !== 'cds serve') {
  throw new Error('Generated start command did not match the TypeScript source command')
}
packageJson.scripts.start = 'cds-serve'

for (const profile of ['[development]', '[production]']) {
  if (auth?.[profile]?.impl !== sourceImpl) {
    throw new Error(`Generated ${profile} auth implementation was not ${sourceImpl}`)
  }
  auth[profile].impl = compiledImpl
}

await writeFile(generatedPackage, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
console.log('Finalized generated auth middleware paths for compiled deployment output.')

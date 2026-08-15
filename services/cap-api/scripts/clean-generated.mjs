import { rm } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.cwd())
for (const relative of ['dist', 'gen', '@cds-models']) {
  const target = path.resolve(root, relative)
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside project: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}

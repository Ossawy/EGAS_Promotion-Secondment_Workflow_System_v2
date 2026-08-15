import { access } from 'node:fs/promises'
import path from 'node:path'

const major = Number(process.versions.node.split('.')[0])
if (!Number.isInteger(major) || major < 22) {
  throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}`)
}

const workspaceLock = path.resolve(process.cwd(), '../../package-lock.json')
await access(workspaceLock)

console.info(`Node.js ${process.versions.node}: compatible`)
console.info('package-lock.json: present')
console.info('Next: copy ../../.env.example to .env, configure a restricted PostgreSQL role, then run npm run db:migrate.')

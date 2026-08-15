import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const repositoryRoot = path.resolve(process.cwd(), '../..')
const excludedNames = new Set([
  '.git',
  'node_modules',
  'gen',
  'dist',
  'coverage',
  'tmp'
])
const textExtensions = new Set([
  '.cds', '.csv', '.js', '.json', '.md', '.mjs', '.sql', '.ts', '.txt', '.yaml', '.yml', ''
])
const patterns = [
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'credentialed PostgreSQL URL', regex: /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@<>]+@/i },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9_]{30,}/ }
]

const findings = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath)
      continue
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue
    const info = await stat(fullPath)
    if (info.size > 2_000_000) continue
    const content = await readFile(fullPath, 'utf8')
    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push(`${path.relative(repositoryRoot, fullPath)}: ${pattern.name}`)
      }
    }
  }
}

await walk(repositoryRoot)
if (findings.length) {
  console.error(findings.join('\n'))
  process.exitCode = 1
} else {
  console.info('No supported secret signatures found in the repository worktree.')
}

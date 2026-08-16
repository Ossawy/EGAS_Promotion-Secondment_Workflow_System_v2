import { cp, mkdir } from 'node:fs/promises'

await mkdir(new URL('../dist/db/', import.meta.url), { recursive: true })
await cp(new URL('../src/db/baseline/', import.meta.url), new URL('../dist/db/baseline/', import.meta.url), { recursive: true })
await cp(new URL('../src/db/migrations/', import.meta.url), new URL('../dist/db/migrations/', import.meta.url), { recursive: true })

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
    'test/phase1-*.test.ts',
    'test/phase2-*.test.ts',
    'test/phase3-*.test.ts',
    'test/phase4-*.test.ts',
    'test/phase5-*.test.ts',
    'test/phase6-*.test.ts',
    'test/config.test.ts'
],
    environment: 'node',
    globals: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    env: { NODE_ENV: 'test' }
  }
})

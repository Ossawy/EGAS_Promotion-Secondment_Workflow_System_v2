import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      CDS_TYPESCRIPT: 'true',
      CDS_TEST_SILENT: 'true',
      NODE_ENV: 'test'
    },
    globals: false,
    sequence: {
      concurrent: false
    },
    testTimeout: 30_000
  }
})

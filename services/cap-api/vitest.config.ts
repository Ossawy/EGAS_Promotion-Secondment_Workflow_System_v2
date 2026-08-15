import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      CDS_TYPESCRIPT: 'true'
    },
    globals: false,
    sequence: {
      concurrent: false
    },
    testTimeout: 30_000
  }
})

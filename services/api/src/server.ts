import { createServer } from 'node:http'
import { createApp } from './app.ts'
import { loadConfig } from './config/env.ts'
import { closePool, getPool } from './db/pool.ts'

const config = loadConfig()
const pool = getPool(config)
const server = createServer(createApp(pool, config))

server.listen(config.port, () => {
  console.info(`EGAS API listening on port ${config.port}`)
})

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.info(`Stopping EGAS API after ${signal}`)
  server.close(async error => {
    await closePool()
    if (error) {
      console.error('HTTP server shutdown failed')
      process.exitCode = 1
    }
  })
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

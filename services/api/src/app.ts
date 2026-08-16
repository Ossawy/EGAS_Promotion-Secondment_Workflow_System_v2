import express, { type Express } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from './config/env.ts'
import { authenticate } from './middleware/authenticate.ts'
import { errorHandler, notFound } from './middleware/error-handler.ts'
import { requestContext } from './middleware/request-context.ts'
import { adminRouter } from './modules/admin/routes.ts'
import { authRouter } from './modules/auth/routes.ts'
import { LocalAuthenticationProvider } from './modules/auth/local-authentication-provider.ts'
import { healthRouter } from './modules/health/routes.ts'
import { referenceRouter } from './modules/reference/routes.ts'
import { employeeDataRouter } from './modules/employee/routes.ts'

export function createApp(pool: Pool, config: AppConfig): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  app.use(express.json({ limit: '1mb', strict: true }))
  app.use(requestContext)
  app.use(authenticate(new LocalAuthenticationProvider(pool, config), config))
  app.use(healthRouter(pool))
  app.use('/api/auth', authRouter(pool, config))
  app.use('/api/admin', adminRouter(pool, config))
  app.use('/api/reference', referenceRouter(pool))
  app.use('/api/employee-data', employeeDataRouter(pool))
  app.use(notFound)
  app.use(errorHandler)
  return app
}

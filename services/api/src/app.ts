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
import { workflowRouter } from './modules/workflow/workflow-routes.ts'
import { signatureRouter } from './modules/signatures/routes.ts'
import { documentRouter } from './modules/workflow/document-routes.ts'

export function createApp(pool: Pool, config: AppConfig): Express {
  const app = express()

  const authenticationProvider = new LocalAuthenticationProvider(pool, config)

  app.disable('x-powered-by')

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    )

    if (_req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store')
    }

    if (
      config.nodeEnv === 'production'
      && config.auth.requireSecureCookie
    ) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      )
    }

    next()
  })

  app.use(express.json({
    limit: '1mb',
    strict: true
  }))

  app.use(requestContext)

  app.use(
    authenticate(authenticationProvider, config)
  )

  app.use(healthRouter(pool))

  app.use('/api/auth', authRouter(pool, config))
  app.use('/api/admin', adminRouter(pool, config))
  app.use('/api/reference', referenceRouter(pool))
  app.use('/api/workflow', workflowRouter(pool, config))
  app.use('/api/signatures', signatureRouter(pool, config))
  app.use('/api/documents', documentRouter(pool, config))

  app.use(notFound)
  app.use(errorHandler)

  return app
}

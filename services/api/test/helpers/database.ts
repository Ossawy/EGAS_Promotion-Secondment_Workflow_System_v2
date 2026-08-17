import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataType, newDb } from 'pg-mem'
import type { Pool } from 'pg'
import type { AppConfig } from '../../src/config/env.js'

export const testConfig: AppConfig = {
  nodeEnv: 'test',
  port: 4004,
  database: { host: 'isolated', port: 5432, database: 'isolated', user: 'isolated', password: 'isolated', ssl: false },
  auth: {
    fingerprintSecret: 'synthetic-test-fingerprint-secret-32',
    sessionCookieName: 'EGAS_SESSION',
    csrfCookieName: 'EGAS_SESSION_CSRF',
    idleMinutes: 30,
    absoluteHours: 8,
    loginWindowMinutes: 10,
    loginFailureLimit: 2,
    lockoutMinutes: 15,
    requireSecureCookie: false,
    allowedOrigins: new Set()
  },
  signatures: {
    storageDirectory: join(tmpdir(), 'egas-signature-tests'),
    maxUploadBytes: 1_048_576,
    maxWidthPixels: 2_048,
    maxHeightPixels: 2_048,
    maxPixels: 4_000_000
  },
  pdf: {
    storageDirectory: join(tmpdir(), 'egas-pdf-tests'),
    maxConcurrentRenders: 2,
    maxQueuedRenders: 20,
    renderTimeoutMs: 15_000,
    maxOutputBytes: 20_971_520
  }
}

export function assertTestDatabaseIsIsolated(config: AppConfig): void {
  if (config.database.database.trim().toLowerCase() === 'egas_workflow_dev') {
    throw new Error('Automated tests refuse to use egas_workflow_dev')
  }
}

export async function isolatedPool(): Promise<Pool> {
  assertTestDatabaseIsIsolated(testConfig)
  const database = newDb({ autoCreateForeignKeyIndices: true })
  database.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 1 })
  database.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 })
  database.public.registerFunction({ name: 'jsonb_typeof', args: [DataType.jsonb], returns: DataType.text,
    implementation: value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value })
  database.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer,
    implementation: value => String(value).length })
  const baseline = await readFile(new URL('../../src/db/baseline/000_existing_cap_schema.sql', import.meta.url), 'utf8')
  database.public.none(baseline)
  const phase3 = await readFile(
    new URL('../../src/db/migrations/003_phase3a_workflow_draft_foundation.sql', import.meta.url), 'utf8'
  )
  database.public.none(phase3.split('-- Phase 3A fresh-install foreign keys.')[0]!)
  const secondment = await readFile(
    new URL('../../src/db/migrations/004_secondment_workflow_integrity.sql', import.meta.url), 'utf8'
  )
  database.public.none(secondment.split('CREATE FUNCTION pg_temp.egas_add_fk_if_absent')[0]!)
  const pdfEvidence = await readFile(
    new URL('../../src/db/migrations/006_pdf_evidence_freeze.sql', import.meta.url), 'utf8'
  )
  database.public.none(pdfEvidence.split('CREATE OR REPLACE FUNCTION egas_protect_frozen_pdf_document')[0]!)
  const promotionCrossRouting = await readFile(
    new URL('../../src/db/migrations/007_promotion_cross_department_review.sql', import.meta.url), 'utf8'
  )
  database.public.none(promotionCrossRouting.replace(/\s+DEFERRABLE INITIALLY DEFERRED/gi, ''))
  const adapter = database.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool
  await pool.query(
    `INSERT INTO egas_schemamigration (version,sha256,appliedat)
     VALUES ('002_phase2b_annual_snapshot_integrity',$1,CURRENT_TIMESTAMP),
            ('003_phase3a_workflow_draft_foundation',$1,CURRENT_TIMESTAMP),
            ('004_secondment_workflow_integrity',$1,CURRENT_TIMESTAMP),
            ('005_promotion_workflow_integrity',$1,CURRENT_TIMESTAMP),
            ('006_pdf_evidence_freeze',$1,CURRENT_TIMESTAMP),
            ('007_promotion_cross_department_review',$1,CURRENT_TIMESTAMP)`, ['0'.repeat(64)]
  )
  return pool
}

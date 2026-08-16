# PostgreSQL implementation authority

## Authority and preservation

`docs/requirements/EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql` remains the frozen pre-implementation design reference and must never be imported over an application database. The runtime authority is:

```text
preserved physical schema baseline
  -> services/api/src/db/baseline/000_existing_cap_schema.sql (fresh empty installs only)
  -> services/api/src/db/migrations/*.sql (immutable applied versions)
```

The framework migration did not rename/drop/recreate baseline tables or modify applied migration `001_postgres_integrity.sql`. After additive migration 006, existing databases contain 32 `egas_*` tables plus historical `cds_model` and `cds_outbox_messages` (34 public tables total), rows, indexes, checks, triggers, and `egas_schemamigration` versions/checksums. Neither CAP technical table is used by application code.

## Access and transactions

The service owns one `pg.Pool`. Runtime connects as restricted `egas_app`; deployment uses the actual schema/object owner. All untrusted values use `$1`, `$2`, ... parameters. SQL identifiers/order clauses are code constants. Security-sensitive operations acquire one client, run `BEGIN`, all mutations/session effects/security-event insertion, then `COMMIT`; errors trigger `ROLLBACK`; `finally` always releases the client.

PostgreSQL `timestamp without time zone` columns are preserved for compatibility. Authentication durations/windows are calculated from PostgreSQL `CURRENT_TIMESTAMP` plus bound interval values, avoiding application/database timezone drift. Server timestamps remain authoritative.

## Migration runner

- Transaction-scoped advisory lock serializes runners.
- A handwritten legacy `egas.routing_unit` schema, or coexistence with the application schema, blocks migration.
- Existing installations must contain the complete expected physical table inventory. The fresh baseline is neither executed nor recorded there.
- Empty installations execute the preserved baseline, including the 22/5/2 reference rows, then versioned migrations.
- Each migration is checksum-tracked in `egas_schemamigration`; changed applied files fail closed.
- A complete SQL file is passed to one parameter-free `pg` query on the transaction client. Nothing splits on semicolons, so functions, strings, DO blocks, triggers, and dollar-quoted PL/pgSQL are supported.
- The checksum row is inserted only after the full script succeeds and remains in the same transaction.

Migration 001 remains byte-for-byte the verified applied file even though its comments describe the previous CDS authority.

Migration `002_phase2b_annual_snapshot_integrity.sql` is the first Phase 2B additive migration. It adds a partial unique index allowing only one `ACTIVATED` import batch per year and attaches the existing append-only trigger function to `egas_employeeannualsnapshot`. It creates no duplicate data tables and changes no baseline/001 SQL.

Migration `003_phase3a_workflow_draft_foundation.sql` (SHA-256 `01e9e6c34657a0a6f15ce8cbbfc322c5dccc97b2a47ec177d1ea3b03662e7ec0`) is required because the preserved physical model made routing, authority, and form-section references mandatory before Phase 3A could legally know them. It permits a request shell before its first candidate, permits draft candidates before future form-section behavior, adds soft-removal evidence plus a partial active-candidate uniqueness/index, validates authority-snapshot coherence and cycle/stage codes, and fills missing workflow foreign keys on fresh preserved-baseline installations without duplicating constraints on upgraded databases. It creates no replacement workflow tables and preserves all rows.

Migration `004_secondment_workflow_integrity.sql` (SHA-256 `bdbdf8846f44ab3474105a46bd2fcd9d0027d6008c4c9062c9a6fa8358e934f7`) adds the Secondment position-selection and task uniqueness invariants plus preserved physical foreign keys. Migration `005_promotion_workflow_integrity.sql` (SHA-256 `5fa7f568dc8200e51d8d58c72648d5aaf99d352432dec04db2157d199ad276db`) adds the Promotion-decision foreign keys while preserving migration 001's Same/Other Position checks.

Migration `006_pdf_evidence_freeze.sql` (SHA-256 `8edff26bad677d75ba24bd88e2ff9824c61117c89782f32c8b92e787c1c60bf6`) adds one evidence table because the frozen logical schema records PDF generation but has no place to retain the final approved source snapshot or the server-only identity of immutable PDF bytes. `egas_FrozenPdfDocument` stores canonical JSON/hash at final approval (or copies an existing immutable received-stage snapshot), then permits exactly one NULL-to-materialized metadata update. Partial unique indexes enforce one received PDF per stage snapshot and one final PDF per request/iteration. A trigger rejects source-evidence changes, replacement of materialized bytes, and deletes. The runtime grant keeps `UPDATE` only for the one-time materialization guarded by that trigger and revokes `DELETE`.

## Least privilege

`services/api/db/operations/least-privilege-role.sql.example` validates the database owner, accepts a `public` owner of either that role or `pg_database_owner`, verifies every public table/view/sequence owner, verifies the runtime role is restricted, and verifies the invoker can manage owner defaults. It uses `ON_ERROR_STOP`, deliberate SQL errors before `BEGIN`, and rollback-on-verification failures; no incompatible `\quit` arguments are used.

The script grants CONNECT, schema USAGE, current/future table DML, and sequence USAGE/SELECT; denies database/schema CREATE and TEMPORARY; revokes write access to migration metadata; revokes UPDATE/DELETE on append-only entities, revokes DELETE on frozen PDF evidence, and revokes all privileges on historical CAP model/outbox tables. Rerun it after controlled migrations.

## Driver warning status

The previous `Calling client.query() when the client is already executing a query` warning originated in CAP dependency concurrency, not the repository's sequential migration code. Those dependencies are retired. The Express/`pg` implementation awaits every same-client query and has no such concurrent-query path; no suppression or unsafe workaround is applied.

The detailed physical table and operation mapping is in [cap-to-node-parity.md](cap-to-node-parity.md).

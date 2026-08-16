# PostgreSQL implementation authority

## Authority and preservation

`docs/requirements/EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql` remains the frozen pre-implementation design reference and must never be imported over an application database. The runtime authority is:

```text
preserved physical schema baseline
  -> services/api/src/db/baseline/000_existing_cap_schema.sql (fresh empty installs only)
  -> services/api/src/db/migrations/*.sql (immutable applied versions)
```

The framework migration did not rename/drop/recreate tables or modify applied migration `001_postgres_integrity.sql`. Existing databases retain all 31 `egas_*` tables plus historical `cds_model` and `cds_outbox_messages` (33 public tables total), rows, indexes, checks, triggers, and `egas_schemamigration` versions/checksums. Neither CAP technical table is used by application code.

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

## Least privilege

`services/api/db/operations/least-privilege-role.sql.example` validates the database owner, accepts a `public` owner of either that role or `pg_database_owner`, verifies every public table/view/sequence owner, verifies the runtime role is restricted, and verifies the invoker can manage owner defaults. It uses `ON_ERROR_STOP`, deliberate SQL errors before `BEGIN`, and rollback-on-verification failures; no incompatible `\quit` arguments are used.

The script grants CONNECT, schema USAGE, current/future table DML, and sequence USAGE/SELECT; denies database/schema CREATE and TEMPORARY; revokes write access to migration metadata; revokes UPDATE/DELETE on append-only entities; and revokes all privileges on historical CAP model/outbox tables. Rerun it after controlled migrations.

## Driver warning status

The previous `Calling client.query() when the client is already executing a query` warning originated in CAP dependency concurrency, not the repository's sequential migration code. Those dependencies are retired. The Express/`pg` implementation awaits every same-client query and has no such concurrent-query path; no suppression or unsafe workaround is applied.

The detailed physical table and operation mapping is in [cap-to-node-parity.md](cap-to-node-parity.md).

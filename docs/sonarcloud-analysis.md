# SonarCloud analysis scope

The repository excludes only three categories from maintainability analysis:

- `docs/requirements/**` contains authoritative requirements and frozen schema inputs.
- `services/api/src/db/baseline/000_existing_cap_schema.sql` is a historical generated PostgreSQL baseline. Its `VARCHAR` declarations are valid PostgreSQL; Oracle-oriented `VARCHAR2` advice does not apply.
- `services/api/src/db/migrations/001_postgres_integrity.sql` is already applied and checksum-protected, so style-only edits are prohibited.

Application TypeScript, tests, migration 002, and future migrations remain analyzable. The exclusions are repository-relative in `sonar-project.properties`; no SQL-wide or rule-wide suppression is used.

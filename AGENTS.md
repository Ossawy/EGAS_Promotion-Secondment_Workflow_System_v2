# EGAS implementation guardrails

1. `docs/requirements/EGAS_Requirements_Architecture_Baseline_v2.0_Final.pdf` is the authoritative business and architecture baseline.
2. `docs/requirements/EGAS_PostgreSQL_Logical_Schema_v1.0_Final.sql` is the frozen pre-implementation logical schema. The repository-owned CDS model and versioned migrations are the runtime implementation authority.
3. Do not derive decisions from older v0.x schemas or older SRS/architecture drafts where they conflict with the final baselines.
4. Keep the SAP CAP Node.js/TypeScript modular monolith and PostgreSQL through `@cap-js/postgres`. Do not add Prisma, NestJS, Sequelize, TypeORM, microservices, direct SAP database access, or direct Active Directory integration.
5. Enforce authorization in the backend under exactly one active role. Never union permissions from a multi-role account for one action.
6. Never expose generic client-writable workflow status/stage/actor/snapshot fields. State changes belong behind explicit service actions.
7. Never concatenate untrusted values into SQL or HTML. Use CAP/CDS queries or bound parameters and encoded output.
8. Never commit secrets, real staff/HR workbooks, real signatures, generated employee PDFs, or database backups.
9. Do not invent missing business rules. Record genuine gaps in the parity/implementation documentation.

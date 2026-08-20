# EGAS implementation guardrails

1. `docs/requirements/EGAS_Requirements_System_Architecture_Baseline_v5.2_Implementation_Ready.pdf` is the authoritative business, workflow, security, data, and architecture baseline.
2. `docs/architecture/EGAS_Implementation_Blueprint_v1.0.md` is the implementation map. It must not override v5.2 business intent.
3. The clean v5 PostgreSQL schema begins with `services/api/src/db/migrations/001_initial_v5_schema.sql`. Historical v3/v4 migrations and schemas are reference-only and must not be used as an active baseline.
4. Keep the plain Node.js/TypeScript Express 5 modular monolith and PostgreSQL through `pg`. Do not add SAP CAP/CDS/CQN, Prisma, NestJS, Sequelize, TypeORM, Drizzle, GraphQL, OData, microservices, direct SAP database access, or direct Active Directory integration.
5. ADMIN accounts are administrative-only. OPERATIONAL accounts have exactly one active unit membership; manager authority derives only from an effective same-unit `UnitManagerAssignment`. Never use active-role switching, role unions, job titles, authority assignments, or delegations as operational authority sources.
6. Never expose generic client-writable workflow status/stage/actor/snapshot fields. State changes belong behind explicit service actions.
7. Never concatenate untrusted values into SQL or HTML. Use PostgreSQL `$1`, `$2`, ... parameters and encoded output.
8. Never commit secrets, real staff/HR workbooks, real signatures, generated employee PDFs, or database backups.
9. Do not invent missing business rules. Record genuine gaps in the parity/implementation documentation.

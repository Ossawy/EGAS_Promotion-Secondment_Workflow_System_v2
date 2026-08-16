# Phase 2B annual employee data and routing

## Scope and physical-schema inventory

Phase 2B uses the existing Express 5 + TypeScript + `pg` modular monolith. There is no CAP/CDS/CQN/SAP runtime and no end-user workbook-upload endpoint. The controlled CLI is the only XLSX ingestion boundary.

The repository baseline and live PostgreSQL catalog were inspected before implementation. Phase 2B reuses these existing public tables and physical columns:

- `egas_importbatch`: year, source basename/SHA-256, exact detected-header JSON, operator/time, state, and aggregate counts.
- `egas_employeeimportstagingrow`: batch/source row, raw JSON, normalized approved fields, resolved RoutingUnit, validation state/messages.
- `egas_routingunitsourcealias`: one exact source label, target RoutingUnit, active/configuration evidence.
- `egas_employee`: stable UUID plus globally unique Personnel Number.
- `egas_employeeannualsnapshot`: batch/year/employee identity, approved annual fields, exact source routing label, resolved RoutingUnit, source row, creation time, and unique `(snapshotyear, personnelnumber)`.
- `egas_routingunit`, `egas_useraccount`, `egas_useraccountrole`, and `egas_securityevent` for exact active routing, operator authorization, and aggregate evidence.

The upgraded live schema already has the expected deferred foreign keys from staging/snapshots/aliases/batches to their parents. It lacked two required integrity rules. Additive migration `002_phase2b_annual_snapshot_integrity.sql` therefore adds one activated batch per year and append-only annual snapshots. The frozen baseline and migration 001 were not edited.

## Controlled import

Run:

```powershell
npm run data:import -- --file <approved-xlsx-path> --year 2026 --operator <active-admin-username>
```

The operator must resolve to an active application account with an active `ADMIN` assignment; `canManageAdmins` is not required. The CLI path is local and operator-controlled, may point outside the repository, and is never exposed as an HTTP upload/path parameter. Only the basename is persisted. The process closes its pool on success/failure and prints aggregate JSON only.

The importer accepts `.xlsx` only. Before Excel parsing it verifies a regular file, ZIP signature and central directory, single-disk/non-ZIP64 structure, safe entry paths, supported compression, entry/file/expanded-size bounds, and required OOXML parts. It rejects `.xls`, `.xlsm`, macros, executable/unknown `.bin` parts, ActiveX, embeddings, external links/relationships, encrypted entries, malformed CRC/OOXML, formulas, error cells, excessive worksheets/rows/columns, and overlong cells. Standard bounded `xl/printerSettings/printerSettingsN.bin` metadata is allowed because approved Excel-generated workbooks may contain it and it is never executed or interpreted by the importer.

Current limits are 25 MiB source, 100 MiB expanded, 50 MiB per entry, 2,000 ZIP entries, 10 worksheets, 25,000 data rows, 100 columns, and 2,000 characters per cell. These are defense-in-depth bounds for the stated EGAS scale, not business-row truncation.

## Required headers and staging

The 2026 required headers are matched by name, not position:

1. `رقم الموظف`
2. `اسم الموظف`
3. `المجموعة الفرعية`
4. `النيابة /المساعد`
5. `الوظيفة`
6. `تقرير كفاية 2026`
7. `المؤسسة التعليمية-المؤهل الاصلي`
8. `الشهادة-المؤهل الاصلي`
9. `تاريخ المؤهل الاصلي`

Leading/trailing header whitespace is ignored for compatibility; internal spelling/spacing is exact. Missing, duplicate/ambiguous, multiple matching header rows/sheets, and unrelated workbooks fail before staging. Additional columns such as the source sequence column are preserved in raw JSON but are not treated as business fields. A later year's performance header requires the explicit nonsecret `EGAS_IMPORT_PERFORMANCE_HEADER` configuration.

Every nonempty source row is stored once with its source row number and raw header/value object. Normalized fields and message codes are stored separately. APIs do not return the raw object.

Validation states are `VALID`, `WARNING`, and `BLOCKED` after completed validation (`PENDING` remains a schema-supported transient state). Batch status becomes `VALIDATED` even when blocked rows exist; this means validation completed, not that activation is allowed.

## Normalization and routing rules

- Text is trimmed only at its outer edges. Arabic and internal text are preserved; no transliteration or inferred HR fields are added.
- Personnel Number and employee name are required. Display text is used for Personnel Number so formatted leading zeroes survive. Every duplicate Personnel Number in one batch is `BLOCKED`.
- Performance blank/whitespace/`10` becomes NULL with a missing warning. `ممتاز` and `جيد جدا` are normal. `جيد` is a warning, not rejection. Any other nonblank value is blocking.
- Routing blank/whitespace/`10` becomes NULL and is blocking.
- Qualification date accepts an actual Excel/JavaScript date, a bounded Excel serial date, ISO `YYYY-MM-DD`, or unambiguous day-first slash/hyphen dates. Blank is NULL; impossible/unknown formats are blocking.
- Subgroup is preserved as supplied and never becomes a second eligibility filter.
- `الإدارة` and `التبعية التنظيمية` are not fabricated.

Routing resolution has exactly two ordered checks: an exact active `egas_routingunit.namear` match, then an exact active source alias whose target RoutingUnit is active. There is no fuzzy, normalized-internal-whitespace, substring, Levenshtein, AI, spelling-correction, or automatic unit/alias creation. Unresolved labels remain blocking and are returned only as distinct label/count aggregates.

## Alias, batch, activation, and lookup APIs

All `/api/admin/*` routes require an authenticated session with exactly `activeRole=ADMIN`; mutations also require trusted Origin and CSRF. Alias changes do not require `canManageAdmins`.

- `GET/POST /api/admin/routing-aliases`
- `PATCH /api/admin/routing-aliases/:id`
- `POST /api/admin/routing-aliases/:id/deactivate`
- `GET /api/admin/import-batches?year=&status=&skip=&top=`
- `GET /api/admin/import-batches/:id`
- `GET /api/admin/import-batches/:id/rows?status=&skip=&top=`
- `GET /api/admin/import-batches/:id/unmapped-routing-labels`
- `POST /api/admin/import-batches/:id/revalidate`
- `POST /api/admin/import-batches/:id/activate`

Revalidation reloads preserved raw rows and uses the same normalizer/resolver as initial staging. It updates only derived staging fields/totals, records aggregate evidence, and refuses activated batches. The matching CLI is:

```powershell
npm run data:revalidate -- --batch <UUID> --operator <active-admin-username>
```

Activation is never implicit and fails closed until migration `002_phase2b_annual_snapshot_integrity` is recorded. It requires a header-valid `VALIDATED` full batch, at least one row, consistent totals, zero blocked rows, and only `VALID`/`WARNING` rows with required identity/routing values. One transaction/client and a transaction advisory lock recheck all conditions, reject an existing active/snapshot year, find-or-create stable Employee identities, insert the year's immutable snapshots, conditionally mark the batch `ACTIVATED`, write aggregate security evidence, and commit. Any error rolls back. The partial unique index is the database race backstop. A second activation or same-year replacement is rejected; no supersede workflow is invented.

The explicit technical command is:

```powershell
npm run data:activate -- --batch <UUID> --operator <active-admin-username>
```

Employee lookup requires exactly `activeRole=EMPLOYEE_AFFAIRS`:

- `GET /api/employee-data/active-snapshot`
- `GET /api/employee-data/employees/:personnelNumber`

Lookup chooses the highest-year `ACTIVATED` batch, never a staged/newest fallback. It returns an allow-listed annual DTO plus derived `جيد`/missing-performance flags. No active snapshot is an explicit conflict; an absent Personnel Number is a safe 404; neither falls back to another year.

## Audit, real data, and pilot status

Aggregate security events cover staged/validation-failed/validation-completed batches, alias create/update/deactivate, revalidation, activation, and rejected activation. Details contain batch/alias IDs, year, counts, checksum, safe source basename, RoutingUnit ID, and reason code where applicable—never an HR row, employee name/number, password, token, or database secret.

Real HR workbooks remain outside Git and tests. Automated fixtures are programmatically generated and synthetic; test startup explicitly refuses `egas_workflow_dev`. Real acceptance is staging/validation only until EGAS approves every required alias/correction. Do not activate with blocked rows and do not guess aliases.

`pilot:check` remains truthful. Annual-snapshot status turns true only after genuine explicit activation. Authority coverage remains independently false at 0/22 until real assignments are configured; no employee workbook data is used to infer authority.

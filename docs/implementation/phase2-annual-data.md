# Phase 2 Implementation Summary — Annual Employee Data & XLSX Import

## Overview

Phase 2 implements the authoritative annual employee population pipeline:
- Secure XLSX inspection (OOXML ZIP verification, macro/activex rejection, worksheet dimension bounds).
- Conservative semantic header validation across all 21 approved columns (A:U) matching the canonical workbook contract (`بيانات IT.XLSX`).
- Reference sheet `نيابة مساعد` parsing and deduplication for diagnostic/reference context without mutating database entities.
- Dynamic performance report header validation (`تقرير كفاية <YEAR>`) verifying the exact snapshot year.
- Duration triplet parsing and header-encoded reference date preservation (`YYYY-01-01` for experience, `YYYY-07-01` for job tenure).
- Transactional staging in `import_batch` and `employee_import_staging_row`.
- Deterministic routing resolution with `ROUTING_UNMAPPED` and `ROUTING_AMBIGUOUS` detection.
- Revalidation capability for unactivated batches upon alias or routing changes.
- Concurrency-safe, fail-closed activation into immutable `employee_annual_snapshot` with stable `employee` keying.

## Performance Rating Rules (Updated)

The three approved annual performance ratings are:
- `ممتاز` &rarr; `VALID`
- `جيد جدا` &rarr; `VALID`
- `جيد` &rarr; `VALID`

Under the approved updated business rule, `جيد` is treated as a fully valid rating and does **not** generate any validation warning, workflow warning, or staging status change.

Other performance values:
- Missing / sentinel (`"10"` or blank) &rarr; `null` with a `PERFORMANCE_MISSING` warning.
- Unknown / unapproved string values &rarr; `BLOCKING` validation error (`PERFORMANCE_UNKNOWN`).

## Known Requirement Gap: General Administration / Department Name

> [!IMPORTANT]
> **Source-Data Gap Documented**:
> The v5.2 baseline architecture references `general_administration` / `department_name` on the official Promotion form layout.
> However, the approved annual workbook layout (A:U in `بيانات IT.XLSX`) does not contain an explicit column for department or general administration.
> In accordance with Phase 2 implementation guardrails:
> - `department_name` is **not** inferred or guessed from `النيابة / المساعد` (which represents the routing authority).
> - No synthetic or unapproved columns have been added to the workbook contract.
> - This source-data requirement gap is intentionally preserved as an unresolved stakeholder decision item for future Promotion form data resolution.

# Phase 1 backend pilot setup

This runbook starts only the Phase 1 CAP backend. Workflow and Admin React applications are not yet implemented.

1. Install Node.js 22+ and PostgreSQL on the pilot machine.
2. Clone the private repository and run `npm install` followed by `npm run setup`.
3. Create an empty development/pilot database with separate migration-owner and restricted runtime roles.
4. Copy `.env.example` to `services/cap-api/.env`; put only machine-local values in the copy.
5. Run `npm run db:migrate` with controlled migration-owner credentials. Switch the runtime configuration back to the restricted application role afterward.
6. Set temporary bootstrap environment values and run `npm run admin:bootstrap` once.
7. Do not load a real employee workbook in Phase 1. The current import command performs validation only.
8. Run `npm run build`, `npm test`, `npm run security:check`, and `npm run pilot:check`.
9. Run `npm run pilot` and access the CAP service on the locally reported port.

Preflight is expected to remain red for annual snapshot activation and 22 authority assignments until Phase 2 data/routing setup is completed. This is an explicit setup gate, not permission to invent mappings.

Never move pilot state by copying source-controlled secrets or real HR files. Use an approved future backup/restore procedure or repeat the controlled importer after it is implemented.

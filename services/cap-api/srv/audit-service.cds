@path: '/audit-foundation'
@requires: 'ADMIN'
service AuditService {
  // AuditEvent is intentionally not exposed as generic CRUD.
  function foundationStatus() returns String;
}

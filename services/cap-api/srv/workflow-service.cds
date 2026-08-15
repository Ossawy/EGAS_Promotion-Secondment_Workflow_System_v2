@path: '/workflow-foundation'
@requires: ['EMPLOYEE_AFFAIRS', 'ORGANIZATION', 'APPROVING_AUTHORITY']
service WorkflowService {
  // Deliberately no generic WorkflowRequest CRUD projection in Phase 1.
  // Later state changes must be explicit, validated CAP actions.
  function foundationStatus() returns String;
}

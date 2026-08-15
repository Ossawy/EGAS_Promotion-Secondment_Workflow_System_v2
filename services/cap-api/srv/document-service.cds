@path: '/document-foundation'
@requires: ['EMPLOYEE_AFFAIRS', 'ORGANIZATION', 'APPROVING_AUTHORITY', 'ADMIN']
service DocumentService {
  // Document generation actions are added only with the isolated renderer phase.
  function foundationStatus() returns String;
}

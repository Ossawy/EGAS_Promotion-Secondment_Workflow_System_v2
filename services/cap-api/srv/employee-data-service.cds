@path: '/employee-data-foundation'
@requires: ['EMPLOYEE_AFFAIRS', 'ORGANIZATION', 'APPROVING_AUTHORITY']
service EmployeeDataService {
  function foundationStatus() returns String;
}

using { egas as db } from '../db/model';

@path: '/admin-foundation'
@requires: 'ADMIN'
service AdminService {
  @readonly entity RoutingUnits as projection on db.RoutingUnit;
  @readonly entity JobCategories as projection on db.JobCategoryReference;
  @readonly entity QualificationStatuses as projection on db.QualificationStatusReference;

  function foundationStatus() returns String;
}

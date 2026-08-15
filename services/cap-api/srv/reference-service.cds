using { egas as db } from '../db/model';

@path: '/reference'
@requires: 'authenticated-user'
service ReferenceService {
  @readonly entity RoutingUnits as projection on db.RoutingUnit;
  @readonly entity JobCategories as projection on db.JobCategoryReference;
  @readonly entity QualificationStatuses as projection on db.QualificationStatusReference;
}

using { egas as db } from '../db/model';
using { egas.RoleCode, egas.AuthorityKindCode } from '../db/common';

@path: '/admin'
@requires: 'ADMIN'
service AdminService {
  @readonly entity RoutingUnits as projection on db.RoutingUnit;
  @readonly entity JobCategories as projection on db.JobCategoryReference;
  @readonly entity QualificationStatuses as projection on db.QualificationStatusReference;

  type RoleInput {
    role            : RoleCode;
    canManageAdmins : Boolean;
  }

  type UserRoleView {
    role            : RoleCode;
    canManageAdmins : Boolean;
    isActive        : Boolean;
  }

  type UserView {
    ID                 : UUID;
    username           : String(120);
    staffIdentifier    : String(120);
    displayName        : String(300);
    jobTitle           : String(300);
    mustChangePassword : Boolean;
    isActive           : Boolean;
    isLocked           : Boolean;
    createdAt          : Timestamp;
    updatedAt          : Timestamp;
    version            : Integer;
    roles              : many UserRoleView;
  }

  type AuthorityAssignmentView {
    ID                : UUID;
    routingUnit_ID    : UUID;
    userAccount_ID    : UUID;
    authorityKind     : AuthorityKindCode;
    authorityJobTitle : String(500);
    isPrimary         : Boolean;
    validFrom         : Date;
    validTo           : Date;
    isActive          : Boolean;
    notes             : String(2000);
    createdAt         : Timestamp;
    updatedAt         : Timestamp;
    version           : Integer;
  }

  type DelegationView {
    ID                     : UUID;
    authorityAssignment_ID : UUID;
    delegatedUser_ID       : UUID;
    validFrom              : Timestamp;
    validTo                : Timestamp;
    isActive               : Boolean;
    reason                 : String(2000);
    createdAt              : Timestamp;
    version                : Integer;
  }

  function listUsers(search : String(120), skip : Integer, top : Integer)
    returns many UserView;
  function getUser(userId : UUID) returns UserView;
  action createUser(
    username : String(120), staffIdentifier : String(120), displayName : String(300),
    jobTitle : String(300), temporaryPassword : String(256), isActive : Boolean,
    roles : many RoleInput
  ) returns UserView;
  action updateUser(
    userId : UUID, expectedVersion : Integer, staffIdentifier : String(120),
    displayName : String(300), jobTitle : String(300)
  ) returns UserView;
  action assignRole(userId : UUID, role : RoleCode, canManageAdmins : Boolean) returns UserView;
  action revokeRole(userId : UUID, role : RoleCode) returns UserView;
  action disableUser(userId : UUID, expectedVersion : Integer) returns UserView;
  action enableUser(userId : UUID, expectedVersion : Integer) returns UserView;
  action unlockUser(userId : UUID, expectedVersion : Integer) returns UserView;
  action resetPassword(userId : UUID, expectedVersion : Integer, temporaryPassword : String(256))
    returns UserView;

  function listAuthorityAssignments(routingUnitId : UUID, activeOnly : Boolean)
    returns many AuthorityAssignmentView;
  action createAuthorityAssignment(
    routingUnitId : UUID, userAccountId : UUID, authorityKind : AuthorityKindCode,
    authorityJobTitle : String(500), isPrimary : Boolean, validFrom : Date,
    validTo : Date, notes : String(2000)
  ) returns AuthorityAssignmentView;
  action updateAuthorityAssignment(
    assignmentId : UUID, expectedVersion : Integer, authorityKind : AuthorityKindCode,
    authorityJobTitle : String(500), isPrimary : Boolean, validFrom : Date,
    validTo : Date, notes : String(2000)
  ) returns AuthorityAssignmentView;
  action deactivateAuthorityAssignment(assignmentId : UUID, expectedVersion : Integer)
    returns AuthorityAssignmentView;

  function listDelegations(assignmentId : UUID, activeOnly : Boolean)
    returns many DelegationView;
  action createDelegation(
    assignmentId : UUID, delegatedUserId : UUID, validFrom : Timestamp,
    validTo : Timestamp, reason : String(2000)
  ) returns DelegationView;
  action updateDelegation(
    delegationId : UUID, expectedVersion : Integer, validFrom : Timestamp,
    validTo : Timestamp, reason : String(2000)
  ) returns DelegationView;
  action deactivateDelegation(delegationId : UUID, expectedVersion : Integer)
    returns DelegationView;
}

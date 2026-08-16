using { egas.RoleCode } from '../db/common';

@path: '/auth'
@requires: 'any'
service AuthService {
  type RoleContext {
    role            : RoleCode;
    canManageAdmins : Boolean;
  }

  type CurrentUserContext {
    userId             : UUID;
    username           : String(120);
    staffIdentifier    : String(120);
    displayName        : String(300);
    jobTitle           : String(300);
    mustChangePassword : Boolean;
    isActive           : Boolean;
    activeRole         : RoleCode;
    availableRoles     : many RoleContext;
  }

  action login(username : String(120), password : String(256))
    returns CurrentUserContext;
  function me() returns CurrentUserContext;
  action logout() returns Boolean;
  action changePassword(currentPassword : String(256), newPassword : String(256))
    returns CurrentUserContext;
  action selectActiveRole(role : RoleCode) returns CurrentUserContext;
}

namespace egas;

using { cuid } from '@sap/cds/common';
using { egas.RoleCode, egas.IpAddress } from './common';

@assert.unique.username: [username]
@assert.unique.staffIdentifier: [staffIdentifier]
entity UserAccount : cuid {
  username              : String(120) not null;
  staffIdentifier       : String(120);
  displayName           : String(300) not null;
  jobTitle              : String(300);
  passwordHash          : String(500) not null;
  mustChangePassword    : Boolean not null default true;
  isActive              : Boolean not null default true;
  failedLoginCount      : Integer not null default 0;
  lockedUntil           : Timestamp;
  createdAt             : Timestamp not null default $now;
  createdBy             : Association to UserAccount;
  updatedAt             : Timestamp not null default $now;
  passwordChangedAt     : Timestamp;
  deactivatedAt         : Timestamp;
  deactivatedBy         : Association to UserAccount;
  version               : Integer not null default 1;
  roles                 : Association to many UserAccountRole on roles.user = $self;
  sessions              : Association to many AuthSession on sessions.user = $self;
}

@assert.unique.userRole: [user, role]
entity UserAccountRole : cuid {
  user              : Association to UserAccount not null;
  role              : RoleCode not null;
  canManageAdmins   : Boolean not null default false;
  isActive          : Boolean not null default true;
  grantedBy         : Association to UserAccount;
  grantedAt         : Timestamp not null default $now;
  revokedBy         : Association to UserAccount;
  revokedAt         : Timestamp;
}

@assert.unique.tokenHash: [tokenHash]
entity AuthSession : cuid {
  user                   : Association to UserAccount not null;
  tokenHash              : String(128) not null;
  csrfSecretHash         : String(128);
  activeRole             : RoleCode;
  activeRoleSetAt        : Timestamp;
  rotatedFromSession     : Association to AuthSession;
  createdAt              : Timestamp not null default $now;
  lastSeenAt             : Timestamp not null default $now;
  idleExpiresAt          : Timestamp not null;
  absoluteExpiresAt      : Timestamp not null;
  revokedAt              : Timestamp;
  revokedReason          : String(500);
  createdIp              : IpAddress;
  userAgent              : String(1000);
}

entity AuthLoginAttempt : cuid {
  identifierFingerprint : String(128) not null;
  ipAddress              : IpAddress;
  wasSuccessful          : Boolean not null;
  failureReason          : String(200);
  createdAt              : Timestamp not null default $now;
}

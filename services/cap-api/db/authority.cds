namespace egas;

using { cuid } from '@sap/cds/common';
using {
  egas.AuthorityKindCode,
  egas.IpAddress,
  egas.Sha256Hex
} from './common';
using { egas.RoutingUnit } from './reference';
using { egas.UserAccount } from './auth';

entity ApprovingAuthorityAssignment : cuid {
  routingUnit       : Association to RoutingUnit not null;
  userAccount       : Association to UserAccount not null;
  authorityKind     : AuthorityKindCode not null;
  authorityJobTitle : String(500) not null;
  isPrimary         : Boolean not null default true;
  validFrom         : Date not null default $now;
  validTo           : Date;
  isActive          : Boolean not null default true;
  configuredBy      : Association to UserAccount;
  notes             : String(2000);
  createdAt         : Timestamp not null default $now;
  updatedAt         : Timestamp not null default $now;
  version           : Integer not null default 1;
  delegations       : Association to many AuthorityDelegation on delegations.authorityAssignment = $self;
}

entity AuthorityDelegation : cuid {
  authorityAssignment : Association to ApprovingAuthorityAssignment not null;
  delegatedUser       : Association to UserAccount not null;
  createdBy           : Association to UserAccount not null;
  validFrom           : Timestamp not null default $now;
  validTo             : Timestamp;
  isActive            : Boolean not null default true;
  reason              : String(2000);
  createdAt           : Timestamp not null default $now;
  version             : Integer not null default 1;
}

@assert.unique.storageKey: [storageKey]
@assert.unique.fileSha256: [fileSha256]
entity UserSignatureAsset : cuid {
  user              : Association to UserAccount not null;
  storageKey        : String(500) not null;
  mimeType          : String(40) not null;
  fileSizeBytes     : Integer64 not null;
  widthPx           : Integer;
  heightPx          : Integer;
  fileSha256        : Sha256Hex not null;
  isActive          : Boolean not null default true;
  uploadedAt        : Timestamp not null default $now;
  replacedAt        : Timestamp;
  replacedByAsset   : Association to UserSignatureAsset;
  uploadedFromIp    : IpAddress;
}

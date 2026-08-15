namespace egas;

using { cuid } from '@sap/cds/common';
using {
  egas.RoleCode,
  egas.JsonDocument,
  egas.Sha256Hex,
  egas.IpAddress,
  egas.DocumentTypeCode,
  egas.DocumentStateCode,
  egas.PeriodCode
} from './common';
using { egas.RoutingUnit } from './reference';
using { egas.UserAccount } from './auth';
using { egas.ApprovingAuthorityAssignment } from './authority';
using {
  egas.WorkflowRequest,
  egas.WorkflowIteration,
  egas.RequestCandidate,
  egas.StageReceivedSnapshot
} from './workflow';

entity SecurityEvent : cuid {
  actorUser        : Association to UserAccount;
  eventType        : String(120) not null;
  request          : Association to WorkflowRequest;
  routingUnit      : Association to RoutingUnit;
  ipAddress        : IpAddress;
  correlationId    : String(120);
  detailsJson      : JsonDocument not null;
  createdAt        : Timestamp not null default $now;
}

entity Notification : cuid {
  recipientUser    : Association to UserAccount not null;
  request          : Association to WorkflowRequest;
  notificationType: String(120) not null;
  titleAr          : String(500) not null;
  bodyAr           : String(2000);
  createdAt        : Timestamp not null default $now;
  readAt           : Timestamp;
}

@assert.unique.eventHash: [eventHash]
entity AuditEvent : cuid {
  request                       : Association to WorkflowRequest;
  iteration                     : Association to WorkflowIteration;
  requestCandidate              : Association to RequestCandidate;
  actorUser                     : Association to UserAccount;
  actorNameSnapshot             : String(300);
  actorIdentifierSnapshot       : String(120);
  actorRoleSnapshot             : RoleCode;
  routingUnit                   : Association to RoutingUnit;
  approvingAuthorityAssignment  : Association to ApprovingAuthorityAssignment;
  actionCode                    : String(120) not null;
  fromStage                     : String(20);
  toStage                       : String(20);
  reason                        : String(2000);
  metadataJson                  : JsonDocument not null;
  ipAddress                     : IpAddress;
  createdAt                     : Timestamp not null default $now;
  previousHash                  : Sha256Hex;
  eventHash                     : Sha256Hex not null;
}

entity PdfGenerationLog : cuid {
  generatedBy            : Association to UserAccount not null;
  documentType           : DocumentTypeCode not null;
  documentState          : DocumentStateCode not null default 'DRAFT';
  request                : Association to WorkflowRequest;
  stageReceivedSnapshot  : Association to StageReceivedSnapshot;
  routingUnit            : Association to RoutingUnit;
  periodCode             : PeriodCode;
  periodStart            : Date;
  periodEnd              : Date;
  templateVersion        : String(120) not null;
  fileSha256             : Sha256Hex;
  generatedAt            : Timestamp not null default $now;
}

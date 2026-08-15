namespace egas;

using { cuid } from '@sap/cds/common';
using {
  egas.RoleCode,
  egas.RequestTypeCode,
  egas.RequestStatusCode,
  egas.IterationStatusCode,
  egas.TaskStatusCode,
  egas.PromotionDecisionCode,
  egas.NoteScopeCode,
  egas.JsonDocument,
  egas.Sha256Hex
} from './common';
using {
  egas.RoutingUnit,
  egas.JobCategoryReference,
  egas.QualificationStatusReference
} from './reference';
using { egas.UserAccount } from './auth';
using { egas.EmployeeAnnualSnapshot } from './hr';
using {
  egas.ApprovingAuthorityAssignment,
  egas.UserSignatureAsset
} from './authority';

@assert.unique.requestNumber: [requestNumber]
entity WorkflowRequest : cuid {
  requestNumber                       : String(120) not null;
  requestType                         : RequestTypeCode not null;
  cycleYear                           : Integer not null;
  @assert.range: [1, 12]
  formMonth                           : Integer not null;
  @assert.range: [2000, 2200]
  formYear                            : Integer not null;
  routingUnit                         : Association to RoutingUnit not null;
  approvingAuthorityAssignment        : Association to ApprovingAuthorityAssignment not null;
  approvingAuthorityPersonnelSnapshot : String(120) not null;
  approvingAuthorityNameSnapshot      : String(300) not null;
  approvingAuthorityJobTitleSnapshot  : String(500) not null;
  approvingAuthorityKindSnapshot      : String(30) not null;
  createdBy                           : Association to UserAccount not null;
  status                              : RequestStatusCode not null default 'DRAFT';
  currentStage                        : String(20);
  currentIterationNo                  : Integer not null default 1;
  createdAt                           : Timestamp not null default $now;
  updatedAt                           : Timestamp not null default $now;
  completedAt                         : Timestamp;
  cancelledAt                         : Timestamp;
  frozenAt                            : Timestamp;
  version                             : Integer not null default 1;
  formSections                        : Association to many RequestFormSection on formSections.request = $self;
  candidates                          : Association to many RequestCandidate on candidates.request = $self;
  iterations                          : Association to many WorkflowIteration on iterations.request = $self;
}

@assert.unique.requestCategory: [request, jobCategory]
entity RequestFormSection : cuid {
  request       : Association to WorkflowRequest not null;
  jobCategory   : Association to JobCategoryReference not null;
  displayOrder  : Integer not null default 0;
  createdBy     : Association to UserAccount not null;
  createdAt     : Timestamp not null default $now;
}

@assert.unique.requestSnapshot: [request, employeeSnapshot]
entity RequestCandidate : cuid {
  request                            : Association to WorkflowRequest not null;
  formSection                        : Association to RequestFormSection not null;
  employeeSnapshot                   : Association to EmployeeAnnualSnapshot not null;
  displayOrder                       : Integer not null default 0;
  personnelNumberSnapshot            : String(120) not null;
  employeeNameSnapshot               : String(300) not null;
  currentJobSnapshot                 : String(500);
  routingUnitNameSnapshot            : String(300);
  subgroupSnapshot                   : String(200);
  performanceRatingSnapshot          : String(40);
  qualificationSource1Snapshot       : String(500);
  qualificationSource2Snapshot       : String(500);
  qualificationDateSnapshot          : Date;
  lastPromotionReport                : String(1000);
  performanceWarningAcknowledged     : Boolean not null default false;
  performanceWarningAcknowledgedBy   : Association to UserAccount;
  createdAt                          : Timestamp not null default $now;
  version                            : Integer not null default 1;
  secondmentOptions                  : Association to many SecondmentPositionOption on secondmentOptions.requestCandidate = $self;
  promotionDecisions                 : Association to many PromotionDecision on promotionDecisions.requestCandidate = $self;
  notes                              : Association to many WorkflowNote on notes.requestCandidate = $self;
}

@assert.unique.requestIteration: [request, iterationNo]
entity WorkflowIteration : cuid {
  request             : Association to WorkflowRequest not null;
  iterationNo         : Integer not null;
  status              : IterationStatusCode not null default 'ACTIVE';
  startedBy           : Association to UserAccount not null;
  startedAt           : Timestamp not null default $now;
  endedAt             : Timestamp;
  restartReason       : String(2000);
  parentIteration     : Association to WorkflowIteration;
  tasks               : Association to many StageTask on tasks.iteration = $self;
}

entity StageTask : cuid {
  iteration            : Association to WorkflowIteration not null;
  request              : Association to WorkflowRequest not null;
  stageCode            : String(20) not null;
  taskStatus           : TaskStatusCode not null default 'OPEN';
  assignedUser         : Association to UserAccount;
  claimedRoleSnapshot  : RoleCode;
  claimedAt            : Timestamp;
  openedAt             : Timestamp not null default $now;
  completedAt          : Timestamp;
  dueAt                : Timestamp;
  version              : Integer not null default 1;
  receivedSnapshot     : Association to one StageReceivedSnapshot on receivedSnapshot.stageTask = $self;
}

@assert.unique.receivedOncePerTask: [stageTask]
@assert.unique.snapshotSha256: [snapshotSha256]
entity StageReceivedSnapshot : cuid {
  stageTask             : Association to StageTask not null;
  request               : Association to WorkflowRequest not null;
  iteration             : Association to WorkflowIteration not null;
  recipientUser         : Association to UserAccount not null;
  recipientRoleSnapshot : RoleCode not null;
  snapshotJson          : JsonDocument not null;
  snapshotSha256        : Sha256Hex not null;
  templateVersion       : String(120) not null;
  receivedAt            : Timestamp not null default $now;
}

entity SecondmentPositionOption : cuid {
  requestCandidate          : Association to RequestCandidate not null;
  iteration                 : Association to WorkflowIteration not null;
  positionTitle             : String(500) not null;
  organizationalDependency : String(1000);
  qualificationStatus      : Association to QualificationStatusReference;
  enteredBy                 : Association to UserAccount not null;
  displayOrder              : Integer not null default 0;
  isSelected                : Boolean not null default false;
  selectedBy                : Association to UserAccount;
  selectedAt                : Timestamp;
  createdAt                 : Timestamp not null default $now;
  version                   : Integer not null default 1;
}

@assert.unique.candidateIteration: [requestCandidate, iteration]
entity PromotionDecision : cuid {
  requestCandidate : Association to RequestCandidate not null;
  iteration        : Association to WorkflowIteration not null;
  decisionType     : PromotionDecisionCode not null;
  targetJobTitle   : String(500);
  notes            : String(2000);
  decidedBy        : Association to UserAccount not null;
  decidedAt        : Timestamp not null default $now;
}

entity StageAction : cuid {
  request             : Association to WorkflowRequest not null;
  iteration           : Association to WorkflowIteration not null;
  stageTask           : Association to StageTask;
  requestCandidate    : Association to RequestCandidate;
  actorUser           : Association to UserAccount not null;
  actorRoleSnapshot   : RoleCode not null;
  actionCode          : String(80) not null;
  reason              : String(2000);
  payloadJson         : JsonDocument not null;
  createdAt           : Timestamp not null default $now;
}

entity WorkflowNote : cuid {
  request             : Association to WorkflowRequest not null;
  iteration           : Association to WorkflowIteration not null;
  stageTask           : Association to StageTask;
  requestCandidate    : Association to RequestCandidate;
  scopeCode           : NoteScopeCode not null;
  authorUser          : Association to UserAccount not null;
  authorRoleSnapshot  : RoleCode not null;
  messageText         : String(2000) not null;
  createdAt           : Timestamp not null default $now;
}

@assert.unique.requestIterationStage: [request, iteration, stageCode]
entity WorkflowSignoff : cuid {
  request                    : Association to WorkflowRequest not null;
  iteration                  : Association to WorkflowIteration;
  stageTask                  : Association to StageTask;
  stageCode                  : String(20) not null;
  signerUser                 : Association to UserAccount not null;
  signerRoleSnapshot         : RoleCode not null;
  signerNameSnapshot         : String(300) not null;
  signerJobTitleSnapshot     : String(500);
  jobTitleWasOverridden      : Boolean not null default false;
  signatureAsset             : Association to UserSignatureAsset not null;
  signatureSha256Snapshot    : Sha256Hex not null;
  signedAt                   : Timestamp not null default $now;
  createdAt                  : Timestamp not null default $now;
}

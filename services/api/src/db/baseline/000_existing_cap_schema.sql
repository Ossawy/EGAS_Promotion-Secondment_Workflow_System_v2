-- Generated once from the verified CAP CDS schema at checkpoint 8be6b3f.
-- Plain Node owns this immutable fresh-install baseline after independent parity verification.
-- Existing databases do not execute or record this baseline.

CREATE TABLE egas_SchemaMigration (
  version VARCHAR(120) NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  appliedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(version)
);;

CREATE TABLE egas_RoutingUnit (
  ID VARCHAR(36) NOT NULL,
  nameAr VARCHAR(300) NOT NULL,
  code VARCHAR(80),
  unitKind VARCHAR(30),
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  updatedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_RoutingUnit_nameAr UNIQUE (nameAr),
  CONSTRAINT egas_RoutingUnit_code UNIQUE (code)
);;

CREATE TABLE egas_JobCategoryReference (
  code VARCHAR(40) NOT NULL,
  nameAr VARCHAR(120) NOT NULL,
  displayOrder INTEGER NOT NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(code),
  CONSTRAINT egas_JobCategoryReference_nameAr UNIQUE (nameAr)
);;

CREATE TABLE egas_QualificationStatusReference (
  code VARCHAR(40) NOT NULL,
  nameAr VARCHAR(120) NOT NULL,
  displayOrder INTEGER NOT NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(code),
  CONSTRAINT egas_QualificationStatusReference_nameAr UNIQUE (nameAr)
);;

CREATE TABLE egas_UserAccount (
  ID VARCHAR(36) NOT NULL,
  username VARCHAR(120) NOT NULL,
  staffIdentifier VARCHAR(120),
  displayName VARCHAR(300) NOT NULL,
  jobTitle VARCHAR(300),
  passwordHash VARCHAR(500) NOT NULL,
  mustChangePassword BOOLEAN NOT NULL DEFAULT TRUE,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  failedLoginCount INTEGER NOT NULL DEFAULT 0,
  lockedUntil TIMESTAMP,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  createdBy_ID VARCHAR(36),
  updatedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  passwordChangedAt TIMESTAMP,
  deactivatedAt TIMESTAMP,
  deactivatedBy_ID VARCHAR(36),
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID),
  CONSTRAINT egas_UserAccount_username UNIQUE (username),
  CONSTRAINT egas_UserAccount_staffIdentifier UNIQUE (staffIdentifier)
);;

CREATE TABLE egas_UserAccountRole (
  ID VARCHAR(36) NOT NULL,
  user_ID VARCHAR(36) NOT NULL,
  role VARCHAR(30) NOT NULL,
  canManageAdmins BOOLEAN NOT NULL DEFAULT FALSE,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  grantedBy_ID VARCHAR(36),
  grantedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  revokedBy_ID VARCHAR(36),
  revokedAt TIMESTAMP,
  PRIMARY KEY(ID),
  CONSTRAINT egas_UserAccountRole_userRole UNIQUE (user_ID, role)
);;

CREATE TABLE egas_AuthSession (
  ID VARCHAR(36) NOT NULL,
  user_ID VARCHAR(36) NOT NULL,
  tokenHash VARCHAR(128) NOT NULL,
  csrfSecretHash VARCHAR(128),
  activeRole VARCHAR(30),
  activeRoleSetAt TIMESTAMP,
  rotatedFromSession_ID VARCHAR(36),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  lastSeenAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  idleExpiresAt TIMESTAMP NOT NULL,
  absoluteExpiresAt TIMESTAMP NOT NULL,
  revokedAt TIMESTAMP,
  revokedReason VARCHAR(500),
  createdIp VARCHAR(45),
  userAgent VARCHAR(1000),
  PRIMARY KEY(ID),
  CONSTRAINT egas_AuthSession_tokenHash UNIQUE (tokenHash)
);;

CREATE TABLE egas_AuthLoginAttempt (
  ID VARCHAR(36) NOT NULL,
  identifierFingerprint VARCHAR(128) NOT NULL,
  ipAddress VARCHAR(45),
  wasSuccessful BOOLEAN NOT NULL,
  failureReason VARCHAR(200),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_ImportBatch (
  ID VARCHAR(36) NOT NULL,
  snapshotYear INTEGER NOT NULL,
  sourceFilename VARCHAR(500) NOT NULL,
  sourceSha256 VARCHAR(64),
  headerSchemaValidated BOOLEAN NOT NULL DEFAULT FALSE,
  detectedHeadersJson JSONB NOT NULL,
  importedBy_ID VARCHAR(36),
  importedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  status VARCHAR(20) NOT NULL,
  totalRows INTEGER NOT NULL DEFAULT 0,
  validRows INTEGER NOT NULL DEFAULT 0,
  warningRows INTEGER NOT NULL DEFAULT 0,
  blockedRows INTEGER NOT NULL DEFAULT 0,
  notes VARCHAR(2000),
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_EmployeeImportStagingRow (
  ID VARCHAR(36) NOT NULL,
  importBatch_ID VARCHAR(36) NOT NULL,
  sourceRowNumber INTEGER NOT NULL,
  rawJson JSONB NOT NULL,
  personnelNumber VARCHAR(120),
  employeeName VARCHAR(300),
  subgroup VARCHAR(200),
  sourceRoutingUnit VARCHAR(300),
  currentJobTitle VARCHAR(500),
  performanceRating VARCHAR(40),
  qualificationSource1 VARCHAR(500),
  qualificationSource2 VARCHAR(500),
  qualificationDate DATE,
  mappedRoutingUnit_ID VARCHAR(36),
  validationStatus VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  validationMessagesJson JSONB NOT NULL,
  PRIMARY KEY(ID),
  CONSTRAINT egas_EmployeeImportStagingRow_batchRow UNIQUE (importBatch_ID, sourceRowNumber)
);;

CREATE TABLE egas_Employee (
  ID VARCHAR(36) NOT NULL,
  personnelNumber VARCHAR(120) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_Employee_personnelNumber UNIQUE (personnelNumber)
);;

CREATE TABLE egas_EmployeeAnnualSnapshot (
  ID VARCHAR(36) NOT NULL,
  employee_ID VARCHAR(36) NOT NULL,
  importBatch_ID VARCHAR(36) NOT NULL,
  snapshotYear INTEGER NOT NULL,
  personnelNumber VARCHAR(120) NOT NULL,
  employeeName VARCHAR(300) NOT NULL,
  subgroup VARCHAR(200),
  sourceRoutingUnit VARCHAR(300),
  routingUnit_ID VARCHAR(36),
  currentJobTitle VARCHAR(500),
  performanceRating VARCHAR(40),
  qualificationSource1 VARCHAR(500),
  qualificationSource2 VARCHAR(500),
  qualificationDate DATE,
  sourceRowNumber INTEGER,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_EmployeeAnnualSnapshot_yearPersonnel UNIQUE (snapshotYear, personnelNumber)
);;

CREATE TABLE egas_RoutingUnitSourceAlias (
  ID VARCHAR(36) NOT NULL,
  sourceLabel VARCHAR(300) NOT NULL,
  routingUnit_ID VARCHAR(36) NOT NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  configuredBy_ID VARCHAR(36),
  configuredAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  notes VARCHAR(2000),
  PRIMARY KEY(ID),
  CONSTRAINT egas_RoutingUnitSourceAlias_sourceLabel UNIQUE (sourceLabel)
);;

CREATE TABLE egas_ApprovingAuthorityAssignment (
  ID VARCHAR(36) NOT NULL,
  routingUnit_ID VARCHAR(36) NOT NULL,
  userAccount_ID VARCHAR(36) NOT NULL,
  authorityKind VARCHAR(30) NOT NULL,
  authorityJobTitle VARCHAR(500) NOT NULL,
  isPrimary BOOLEAN NOT NULL DEFAULT TRUE,
  validFrom DATE NOT NULL DEFAULT current_timestamp,
  validTo DATE,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  configuredBy_ID VARCHAR(36),
  notes VARCHAR(2000),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  updatedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_AuthorityDelegation (
  ID VARCHAR(36) NOT NULL,
  authorityAssignment_ID VARCHAR(36) NOT NULL,
  delegatedUser_ID VARCHAR(36) NOT NULL,
  createdBy_ID VARCHAR(36) NOT NULL,
  validFrom TIMESTAMP NOT NULL DEFAULT current_timestamp,
  validTo TIMESTAMP,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  reason VARCHAR(2000),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_UserSignatureAsset (
  ID VARCHAR(36) NOT NULL,
  user_ID VARCHAR(36) NOT NULL,
  storageKey VARCHAR(500) NOT NULL,
  mimeType VARCHAR(40) NOT NULL,
  fileSizeBytes BIGINT NOT NULL,
  widthPx INTEGER,
  heightPx INTEGER,
  fileSha256 VARCHAR(64) NOT NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  uploadedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  replacedAt TIMESTAMP,
  replacedByAsset_ID VARCHAR(36),
  uploadedFromIp VARCHAR(45),
  PRIMARY KEY(ID),
  CONSTRAINT egas_UserSignatureAsset_storageKey UNIQUE (storageKey),
  CONSTRAINT egas_UserSignatureAsset_fileSha256 UNIQUE (fileSha256)
);;

CREATE TABLE egas_WorkflowRequest (
  ID VARCHAR(36) NOT NULL,
  requestNumber VARCHAR(120) NOT NULL,
  requestType VARCHAR(20) NOT NULL,
  cycleYear INTEGER NOT NULL,
  formMonth INTEGER NOT NULL,
  formYear INTEGER NOT NULL,
  routingUnit_ID VARCHAR(36) NOT NULL,
  approvingAuthorityAssignment_ID VARCHAR(36) NOT NULL,
  approvingAuthorityPersonnelSnapshot VARCHAR(120) NOT NULL,
  approvingAuthorityNameSnapshot VARCHAR(300) NOT NULL,
  approvingAuthorityJobTitleSnapshot VARCHAR(500) NOT NULL,
  approvingAuthorityKindSnapshot VARCHAR(30) NOT NULL,
  createdBy_ID VARCHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  currentStage VARCHAR(20),
  currentIterationNo INTEGER NOT NULL DEFAULT 1,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  updatedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  completedAt TIMESTAMP,
  cancelledAt TIMESTAMP,
  frozenAt TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID),
  CONSTRAINT egas_WorkflowRequest_requestNumber UNIQUE (requestNumber)
);;

CREATE TABLE egas_RequestFormSection (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  jobCategory_code VARCHAR(40) NOT NULL,
  displayOrder INTEGER NOT NULL DEFAULT 0,
  createdBy_ID VARCHAR(36) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_RequestFormSection_requestCategory UNIQUE (request_ID, jobCategory_code)
);;

CREATE TABLE egas_RequestCandidate (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  formSection_ID VARCHAR(36) NOT NULL,
  employeeSnapshot_ID VARCHAR(36) NOT NULL,
  displayOrder INTEGER NOT NULL DEFAULT 0,
  personnelNumberSnapshot VARCHAR(120) NOT NULL,
  employeeNameSnapshot VARCHAR(300) NOT NULL,
  currentJobSnapshot VARCHAR(500),
  routingUnitNameSnapshot VARCHAR(300),
  subgroupSnapshot VARCHAR(200),
  performanceRatingSnapshot VARCHAR(40),
  qualificationSource1Snapshot VARCHAR(500),
  qualificationSource2Snapshot VARCHAR(500),
  qualificationDateSnapshot DATE,
  lastPromotionReport VARCHAR(1000),
  performanceWarningAcknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  performanceWarningAcknowledgedBy_ID VARCHAR(36),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID),
  CONSTRAINT egas_RequestCandidate_requestSnapshot UNIQUE (request_ID, employeeSnapshot_ID)
);;

CREATE TABLE egas_SecondmentPositionOption (
  ID VARCHAR(36) NOT NULL,
  requestCandidate_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  positionTitle VARCHAR(500) NOT NULL,
  organizationalDependency VARCHAR(1000),
  qualificationStatus_code VARCHAR(40),
  enteredBy_ID VARCHAR(36) NOT NULL,
  displayOrder INTEGER NOT NULL DEFAULT 0,
  isSelected BOOLEAN NOT NULL DEFAULT FALSE,
  selectedBy_ID VARCHAR(36),
  selectedAt TIMESTAMP,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_WorkflowIteration (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iterationNo INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  startedBy_ID VARCHAR(36) NOT NULL,
  startedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  endedAt TIMESTAMP,
  restartReason VARCHAR(2000),
  parentIteration_ID VARCHAR(36),
  PRIMARY KEY(ID),
  CONSTRAINT egas_WorkflowIteration_requestIteration UNIQUE (request_ID, iterationNo)
);;

CREATE TABLE egas_StageTask (
  ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  stageCode VARCHAR(20) NOT NULL,
  taskStatus VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  assignedUser_ID VARCHAR(36),
  claimedRoleSnapshot VARCHAR(30),
  claimedAt TIMESTAMP,
  openedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  completedAt TIMESTAMP,
  dueAt TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_StageReceivedSnapshot (
  ID VARCHAR(36) NOT NULL,
  stageTask_ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  recipientUser_ID VARCHAR(36) NOT NULL,
  recipientRoleSnapshot VARCHAR(30) NOT NULL,
  snapshotJson JSONB NOT NULL,
  snapshotSha256 VARCHAR(64) NOT NULL,
  templateVersion VARCHAR(120) NOT NULL,
  receivedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_StageReceivedSnapshot_receivedOncePerTask UNIQUE (stageTask_ID),
  CONSTRAINT egas_StageReceivedSnapshot_snapshotSha256 UNIQUE (snapshotSha256)
);;

CREATE TABLE egas_PromotionDecision (
  ID VARCHAR(36) NOT NULL,
  requestCandidate_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  decisionType VARCHAR(20) NOT NULL,
  targetJobTitle VARCHAR(500),
  notes VARCHAR(2000),
  decidedBy_ID VARCHAR(36) NOT NULL,
  decidedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_PromotionDecision_candidateIteration UNIQUE (requestCandidate_ID, iteration_ID)
);;

CREATE TABLE egas_WorkflowNote (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  stageTask_ID VARCHAR(36),
  requestCandidate_ID VARCHAR(36),
  scopeCode VARCHAR(20) NOT NULL,
  authorUser_ID VARCHAR(36) NOT NULL,
  authorRoleSnapshot VARCHAR(30) NOT NULL,
  messageText VARCHAR(2000) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_StageAction (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36) NOT NULL,
  stageTask_ID VARCHAR(36),
  requestCandidate_ID VARCHAR(36),
  actorUser_ID VARCHAR(36) NOT NULL,
  actorRoleSnapshot VARCHAR(30) NOT NULL,
  actionCode VARCHAR(80) NOT NULL,
  reason VARCHAR(2000),
  payloadJson JSONB NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_WorkflowSignoff (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36) NOT NULL,
  iteration_ID VARCHAR(36),
  stageTask_ID VARCHAR(36),
  stageCode VARCHAR(20) NOT NULL,
  signerUser_ID VARCHAR(36) NOT NULL,
  signerRoleSnapshot VARCHAR(30) NOT NULL,
  signerNameSnapshot VARCHAR(300) NOT NULL,
  signerJobTitleSnapshot VARCHAR(500),
  jobTitleWasOverridden BOOLEAN NOT NULL DEFAULT FALSE,
  signatureAsset_ID VARCHAR(36) NOT NULL,
  signatureSha256Snapshot VARCHAR(64) NOT NULL,
  signedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID),
  CONSTRAINT egas_WorkflowSignoff_requestIterationStage UNIQUE (request_ID, iteration_ID, stageCode)
);;

CREATE TABLE egas_SecurityEvent (
  ID VARCHAR(36) NOT NULL,
  actorUser_ID VARCHAR(36),
  eventType VARCHAR(120) NOT NULL,
  request_ID VARCHAR(36),
  routingUnit_ID VARCHAR(36),
  ipAddress VARCHAR(45),
  correlationId VARCHAR(120),
  detailsJson JSONB NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_Notification (
  ID VARCHAR(36) NOT NULL,
  recipientUser_ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36),
  notificationType VARCHAR(120) NOT NULL,
  titleAr VARCHAR(500) NOT NULL,
  bodyAr VARCHAR(2000),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  readAt TIMESTAMP,
  PRIMARY KEY(ID)
);;

CREATE TABLE egas_AuditEvent (
  ID VARCHAR(36) NOT NULL,
  request_ID VARCHAR(36),
  iteration_ID VARCHAR(36),
  requestCandidate_ID VARCHAR(36),
  actorUser_ID VARCHAR(36),
  actorNameSnapshot VARCHAR(300),
  actorIdentifierSnapshot VARCHAR(120),
  actorRoleSnapshot VARCHAR(30),
  routingUnit_ID VARCHAR(36),
  approvingAuthorityAssignment_ID VARCHAR(36),
  actionCode VARCHAR(120) NOT NULL,
  fromStage VARCHAR(20),
  toStage VARCHAR(20),
  reason VARCHAR(2000),
  metadataJson JSONB NOT NULL,
  ipAddress VARCHAR(45),
  createdAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  previousHash VARCHAR(64),
  eventHash VARCHAR(64) NOT NULL,
  PRIMARY KEY(ID),
  CONSTRAINT egas_AuditEvent_eventHash UNIQUE (eventHash)
);;

CREATE TABLE egas_PdfGenerationLog (
  ID VARCHAR(36) NOT NULL,
  generatedBy_ID VARCHAR(36) NOT NULL,
  documentType VARCHAR(20) NOT NULL,
  documentState VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  request_ID VARCHAR(36),
  stageReceivedSnapshot_ID VARCHAR(36),
  routingUnit_ID VARCHAR(36),
  periodCode VARCHAR(20),
  periodStart DATE,
  periodEnd DATE,
  templateVersion VARCHAR(120) NOT NULL,
  fileSha256 VARCHAR(64),
  generatedAt TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(ID)
);;

INSERT INTO egas_RoutingUnit (ID, nameAr, isActive) VALUES
  ('00000000-0000-4000-8000-000000000001', 'التخطيط ومشروعات الغاز وتنمية الاعمال', TRUE),
  ('00000000-0000-4000-8000-000000000002', 'العمليات والشبكات', TRUE),
  ('00000000-0000-4000-8000-000000000003', 'الإنتاج وتنمية الحقول', TRUE),
  ('00000000-0000-4000-8000-000000000004', 'التبعية للعضو المنتدب التنفيذى', TRUE),
  ('00000000-0000-4000-8000-000000000005', 'الرقابة على الشركات الاجنبية والمشتركة', TRUE),
  ('00000000-0000-4000-8000-000000000006', 'الشئون المالية', TRUE),
  ('00000000-0000-4000-8000-000000000007', 'الشئون الإدارية', TRUE),
  ('00000000-0000-4000-8000-000000000008', 'الاتفاقيات والاستكشاف', TRUE),
  ('00000000-0000-4000-8000-000000000009', 'التجارة الخارجية', TRUE),
  ('00000000-0000-4000-8000-000000000010', 'الشئون القانونية', TRUE),
  ('00000000-0000-4000-8000-000000000011', 'التجارة الداخلية والشئون الاقتصادية', TRUE),
  ('00000000-0000-4000-8000-000000000012', 'المكتب الفنى والمشروعات الخاصة وسلامة العمليات', TRUE),
  ('00000000-0000-4000-8000-000000000013', 'الأمن', TRUE),
  ('00000000-0000-4000-8000-000000000014', 'العلاقات الحكومية', TRUE),
  ('00000000-0000-4000-8000-000000000015', 'نظم المعلومات والاتصالات', TRUE),
  ('00000000-0000-4000-8000-000000000016', 'الامانة العامة لمجلس الادارة', TRUE),
  ('00000000-0000-4000-8000-000000000017', 'الإعلام', TRUE),
  ('00000000-0000-4000-8000-000000000018', 'حماية البيئة', TRUE),
  ('00000000-0000-4000-8000-000000000019', 'العلاقات الدولية', TRUE),
  ('00000000-0000-4000-8000-000000000020', 'العقود', TRUE),
  ('00000000-0000-4000-8000-000000000021', 'السلامة والصحة المهنية', TRUE),
  ('00000000-0000-4000-8000-000000000022', 'الاستراتيجيات ودعم اتخاذ القرار', TRUE);

INSERT INTO egas_JobCategoryReference (code, nameAr, displayOrder, isActive) VALUES
  ('MANAGER_DEPARTMENT', 'مدير إدارة', 1, TRUE),
  ('SECTION_HEAD', 'رئيس قسم', 2, TRUE),
  ('STANDARD_FIRST', 'نمطي أول', 3, TRUE),
  ('STANDARD_EXCELLENT', 'نمطي ممتاز', 4, TRUE),
  ('STANDARD_SKILLED', 'نمطي ماهر', 5, TRUE);

INSERT INTO egas_QualificationStatusReference (code, nameAr, displayOrder, isActive) VALUES
  ('QUALIFIED', 'مستوفي', 1, TRUE),
  ('NOT_QUALIFIED', 'غير مستوفي', 2, TRUE);

namespace egas;

type RoleCode : String(30) enum {
  ADMIN;
  EMPLOYEE_AFFAIRS;
  ORGANIZATION;
  APPROVING_AUTHORITY;
};

type UnitKindCode : String(30) enum {
  DEPUTY_DOMAIN;
  ASSISTANT_DOMAIN;
  DIRECT_MD;
  OTHER;
};

type AuthorityKindCode : String(30) enum {
  DEPUTY;
  ASSISTANT;
  ACTING_DEPUTY;
  ACTING_ASSISTANT;
  OTHER;
};

type ImportStatusCode : String(20) enum {
  STAGED;
  VALIDATED;
  ACTIVATED;
  FAILED;
  SUPERSEDED;
};

type ValidationStatusCode : String(20) enum {
  PENDING;
  VALID;
  WARNING;
  BLOCKED;
};

type RequestTypeCode : String(20) enum {
  SECONDMENT;
  PROMOTION;
};

type RequestStatusCode : String(20) enum {
  DRAFT;
  IN_PROGRESS;
  RETURNED;
  CANCELLED;
  COMPLETED;
};

type IterationStatusCode : String(20) enum {
  ACTIVE;
  RETURNED;
  CANCELLED;
  COMPLETED;
  RECALLED;
};

type TaskStatusCode : String(20) enum {
  OPEN;
  CLAIMED;
  COMPLETED;
  RETURNED;
  CANCELLED;
};

type PromotionDecisionCode : String(20) enum {
  SAME_POSITION;
  OTHER_POSITION;
};

type NoteScopeCode : String(20) enum {
  REQUEST;
  CANDIDATE;
};

type DocumentTypeCode : String(20) enum {
  FORM;
  AUDIT_LOG;
};

type DocumentStateCode : String(20) enum {
  RECEIVED;
  DRAFT;
  FINAL;
};

type PeriodCode : String(20) enum {
  DAILY;
  WEEKLY;
  MONTHLY;
  QUARTERLY;
  HALF_YEARLY;
  YEARLY;
};

type JsonDocument : Map;
type Sha256Hex : String(64);
type IpAddress : String(45);

// Repository migration bookkeeping; not a business-domain table.
entity SchemaMigration {
  key version   : String(120);
      sha256    : Sha256Hex not null;
      appliedAt : Timestamp not null default $now;
}

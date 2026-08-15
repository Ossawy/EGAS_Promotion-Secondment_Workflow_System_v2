namespace egas;

using { cuid } from '@sap/cds/common';
using {
  egas.ImportStatusCode,
  egas.ValidationStatusCode,
  egas.JsonDocument,
  egas.Sha256Hex
} from './common';
using { egas.RoutingUnit } from './reference';
using { egas.UserAccount } from './auth';

entity ImportBatch : cuid {
  snapshotYear             : Integer not null;
  sourceFilename           : String(500) not null;
  sourceSha256             : Sha256Hex;
  headerSchemaValidated    : Boolean not null default false;
  detectedHeadersJson      : JsonDocument not null;
  importedBy               : Association to UserAccount;
  importedAt               : Timestamp not null default $now;
  status                   : ImportStatusCode not null;
  totalRows                : Integer not null default 0;
  validRows                : Integer not null default 0;
  warningRows              : Integer not null default 0;
  blockedRows              : Integer not null default 0;
  notes                    : String(2000);
  stagingRows              : Association to many EmployeeImportStagingRow on stagingRows.importBatch = $self;
}

@assert.unique.batchRow: [importBatch, sourceRowNumber]
entity EmployeeImportStagingRow : cuid {
  importBatch              : Association to ImportBatch not null;
  sourceRowNumber          : Integer not null;
  rawJson                  : JsonDocument not null;
  personnelNumber         : String(120);
  employeeName            : String(300);
  subgroup                : String(200);
  sourceRoutingUnit       : String(300);
  currentJobTitle         : String(500);
  performanceRating      : String(40);
  qualificationSource1   : String(500);
  qualificationSource2   : String(500);
  qualificationDate      : Date;
  mappedRoutingUnit      : Association to RoutingUnit;
  validationStatus       : ValidationStatusCode not null default 'PENDING';
  validationMessagesJson : JsonDocument not null;
}

@assert.unique.personnelNumber: [personnelNumber]
entity Employee : cuid {
  personnelNumber : String(120) not null;
  createdAt       : Timestamp not null default $now;
  annualSnapshots : Association to many EmployeeAnnualSnapshot on annualSnapshots.employee = $self;
}

@assert.unique.yearPersonnel: [snapshotYear, personnelNumber]
entity EmployeeAnnualSnapshot : cuid {
  employee             : Association to Employee not null;
  importBatch          : Association to ImportBatch not null;
  snapshotYear         : Integer not null;
  personnelNumber      : String(120) not null;
  employeeName         : String(300) not null;
  subgroup             : String(200);
  sourceRoutingUnit    : String(300);
  routingUnit          : Association to RoutingUnit;
  currentJobTitle      : String(500);
  performanceRating   : String(40);
  qualificationSource1: String(500);
  qualificationSource2: String(500);
  qualificationDate   : Date;
  sourceRowNumber      : Integer;
  createdAt            : Timestamp not null default $now;
}

@assert.unique.sourceLabel: [sourceLabel]
entity RoutingUnitSourceAlias : cuid {
  sourceLabel    : String(300) not null;
  routingUnit    : Association to RoutingUnit not null;
  isActive       : Boolean not null default true;
  configuredBy   : Association to UserAccount;
  configuredAt   : Timestamp not null default $now;
  notes          : String(2000);
}

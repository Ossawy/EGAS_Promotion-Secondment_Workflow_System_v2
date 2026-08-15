namespace egas;

using { cuid } from '@sap/cds/common';
using { egas.UnitKindCode } from './common';

@assert.unique.nameAr: [nameAr]
@assert.unique.code: [code]
entity RoutingUnit : cuid {
  nameAr      : String(300) not null;
  code        : String(80);
  unitKind    : UnitKindCode;
  isActive    : Boolean not null default true;
  createdAt   : Timestamp not null default $now;
  updatedAt   : Timestamp not null default $now;
}

@assert.unique.nameAr: [nameAr]
entity JobCategoryReference {
  key code     : String(40);
      nameAr   : String(120) not null;
      displayOrder : Integer not null;
      isActive : Boolean not null default true;
}

@assert.unique.nameAr: [nameAr]
entity QualificationStatusReference {
  key code     : String(40);
      nameAr   : String(120) not null;
      displayOrder : Integer not null;
      isActive : Boolean not null default true;
}

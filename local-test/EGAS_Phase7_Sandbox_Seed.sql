\set ON_ERROR_STOP on

-- EGAS Phase 7 synthetic LOCAL sandbox seed.
-- CURRENT v5 schema only. Do not run against a real/pilot/production database.
--
-- Prerequisites:
--   1) Database egas_workflow_phase7_local exists.
--   2) Migrations 001-004 were applied as egas_phase7_owner.
--   3) Run this script as egas_phase7_owner.
--
-- Example:
--   set PGPASSWORD=ZrSnpXw5vZgrCn2WhEHCSHWB-daIO16l
--   psql -h 127.0.0.1 -U egas_phase7_owner -d egas_workflow_phase7_local -f EGAS_Phase7_Sandbox_Seed.sql

BEGIN;

-- ------------------------------------------------------------
-- Routing units used by the synthetic annual workbook
-- ------------------------------------------------------------
INSERT INTO routing_unit (id, code, name_ar, name_en, is_active)
VALUES
('10000000-0000-4000-8000-000000000001','RU-IT','نظم المعلومات والاتصالات','Information Systems and Communications',TRUE),
('10000000-0000-4000-8000-000000000002','RU-FIN','الشئون المالية','Financial Affairs',TRUE),
('10000000-0000-4000-8000-000000000003','RU-PLAN','التخطيط ومشروعات الغاز وتنمية الاعمال','Planning, Gas Projects and Business Development',TRUE),
('10000000-0000-4000-8000-000000000004','RU-LEGAL','الشئون القانونية','Legal Affairs',TRUE)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Current v5 OperationalUnits
-- ------------------------------------------------------------
INSERT INTO operational_unit (id, kind, name, routing_unit_id, is_active)
VALUES
('20000000-0000-4000-8000-000000000001','HR','شئون العاملين',NULL,TRUE),
('20000000-0000-4000-8000-000000000002','ORG','إدارة التنظيم',NULL,TRUE),
('20000000-0000-4000-8000-000000000101','AUTH','السلطة المختصة - نظم المعلومات والاتصالات','10000000-0000-4000-8000-000000000001',TRUE),
('20000000-0000-4000-8000-000000000102','AUTH','السلطة المختصة - الشئون المالية','10000000-0000-4000-8000-000000000002',TRUE),
('20000000-0000-4000-8000-000000000103','AUTH','السلطة المختصة - التخطيط ومشروعات الغاز وتنمية الاعمال','10000000-0000-4000-8000-000000000003',TRUE),
('20000000-0000-4000-8000-000000000104','AUTH','السلطة المختصة - الشئون القانونية','10000000-0000-4000-8000-000000000004',TRUE)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Reference data used by Secondment
-- ------------------------------------------------------------
INSERT INTO job_category_reference (id, code, name, is_active)
VALUES
('60000000-0000-4000-8000-000000000001','MANAGER','وظيفة مدير إدارة',TRUE),
('60000000-0000-4000-8000-000000000002','SECTION_HEAD','وظيفة رئيس قسم',TRUE),
('60000000-0000-4000-8000-000000000003','SENIOR_SPECIALIST','وظيفة أخصائي أول',TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO qualification_status_reference (id, code, name, is_active)
VALUES
('61000000-0000-4000-8000-000000000001','QUALIFIED','مستوفي',TRUE),
('61000000-0000-4000-8000-000000000002','NOT_QUALIFIED','غير مستوفي',TRUE)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Synthetic login accounts
--
-- Passwords:
--   admin.local -> LocalAdmin!2026
--   all normal operational accounts -> LocalTest!2026
--   hr.trainee -> ChangeMe!2026 (must change password on first login)
-- ------------------------------------------------------------
INSERT INTO user_account
(id, username, staff_identifier, display_name, job_title, account_type, password_hash, must_change_password, is_active)
VALUES
('30000000-0000-4000-8000-000000000001','admin.local','ADM-LOCAL','مدير النظام المحلي','مسؤول النظام','ADMIN',
 '$argon2id$v=19$m=65536,t=3,p=4$i5XQOkSJBnDyI5AueDVocQ$i8k/3mOZdcUUeRW1vuWaAPSg+UJkDi2oMfWp8vqPp4s',FALSE,TRUE),

('30000000-0000-4000-8000-000000000010','hr.manager','HR-MGR','مدير شئون العاملين','مدير شئون العاملين','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000011','hr.employee1','HR-EMP-1','سارة محمود - شئون العاملين','أخصائي شئون عاملين','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000012','hr.employee2','HR-EMP-2','أحمد نبيل - شئون العاملين','باحث شئون عاملين','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000013','hr.trainee','HR-NEW','مستخدم تغيير كلمة المرور','باحث شئون عاملين','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$uxYgnmHlJbzpvOt+nVgMmQ$GfraKAUHgcxPbxhqpfvGglSwtsbX+wkUZUWOZBhdd6c',TRUE,TRUE),

('30000000-0000-4000-8000-000000000020','org.manager','ORG-MGR','مدير إدارة التنظيم','مدير إدارة التنظيم','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000021','org.employee1','ORG-EMP-1','منى عادل - التنظيم','باحث تنظيم أول','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000022','org.employee2','ORG-EMP-2','خالد سامي - التنظيم','باحث تنظيم','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),

('30000000-0000-4000-8000-000000000101','auth.it.manager','AUTH-IT-MGR','مدير السلطة المختصة - نظم المعلومات','مدير عام','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000111','auth.it.employee1','AUTH-IT-E1','مراجع نظم معلومات أول','أخصائي أول','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000112','auth.it.employee2','AUTH-IT-E2','مراجع نظم معلومات','أخصائي','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),

('30000000-0000-4000-8000-000000000102','auth.finance.manager','AUTH-FIN-MGR','مدير السلطة المختصة - الشئون المالية','مدير عام','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000122','auth.finance.employee','AUTH-FIN-E1','مراجع مالي','أخصائي أول','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),

('30000000-0000-4000-8000-000000000103','auth.planning.manager','AUTH-PLAN-MGR','مدير السلطة المختصة - التخطيط','مدير عام','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000133','auth.planning.employee','AUTH-PLAN-E1','مراجع تخطيط','أخصائي أول','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),

('30000000-0000-4000-8000-000000000104','auth.legal.manager','AUTH-LEGAL-MGR','مدير السلطة المختصة - الشئون القانونية','مدير عام','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE),
('30000000-0000-4000-8000-000000000144','auth.legal.employee','AUTH-LEGAL-E1','مراجع قانوني','أخصائي أول','OPERATIONAL',
 '$argon2id$v=19$m=65536,t=3,p=4$OJgAe4kis1EGYTdzBTpn6w$nuZNsC682b8fb/3taF6lNC1Z0C36zhk/6/7KDURnIMM',FALSE,TRUE)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Memberships — exactly one active membership per OPERATIONAL account
-- ------------------------------------------------------------
INSERT INTO user_unit_membership
(id, user_id, unit_id, effective_from, created_by_user_id)
VALUES
('40000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000012','20000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000013','30000000-0000-4000-8000-000000000013','20000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),

('40000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000002',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000002',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000022','30000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000002',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),

('40000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000101','20000000-0000-4000-8000-000000000101',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000111','30000000-0000-4000-8000-000000000111','20000000-0000-4000-8000-000000000101',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000112','30000000-0000-4000-8000-000000000112','20000000-0000-4000-8000-000000000101',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),

('40000000-0000-4000-8000-000000000102','30000000-0000-4000-8000-000000000102','20000000-0000-4000-8000-000000000102',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000122','30000000-0000-4000-8000-000000000122','20000000-0000-4000-8000-000000000102',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),

('40000000-0000-4000-8000-000000000103','30000000-0000-4000-8000-000000000103','20000000-0000-4000-8000-000000000103',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000133','30000000-0000-4000-8000-000000000133','20000000-0000-4000-8000-000000000103',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),

('40000000-0000-4000-8000-000000000104','30000000-0000-4000-8000-000000000104','20000000-0000-4000-8000-000000000104',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('40000000-0000-4000-8000-000000000144','30000000-0000-4000-8000-000000000144','20000000-0000-4000-8000-000000000104',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- One effective manager per OperationalUnit
-- ------------------------------------------------------------
INSERT INTO unit_manager_assignment
(id, unit_id, manager_user_id, effective_from, assigned_by_user_id)
VALUES
('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000010',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000020',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('50000000-0000-4000-8000-000000000101','20000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000101',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('50000000-0000-4000-8000-000000000102','20000000-0000-4000-8000-000000000102','30000000-0000-4000-8000-000000000102',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('50000000-0000-4000-8000-000000000103','20000000-0000-4000-8000-000000000103','30000000-0000-4000-8000-000000000103',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001'),
('50000000-0000-4000-8000-000000000104','20000000-0000-4000-8000-000000000104','30000000-0000-4000-8000-000000000104',CURRENT_TIMESTAMP,'30000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

COMMIT;

-- ------------------------------------------------------------
-- Local runtime grants.
-- These are intentionally pragmatic for a synthetic sandbox only.
-- The repository's official production least-privilege script should be
-- independently reviewed/fixed before real deployment.
-- ------------------------------------------------------------
REVOKE CREATE ON DATABASE egas_workflow_phase7_local FROM egas_phase7_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM egas_phase7_app;
GRANT CONNECT ON DATABASE egas_workflow_phase7_local TO egas_phase7_app;
GRANT USAGE ON SCHEMA public TO egas_phase7_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO egas_phase7_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO egas_phase7_app;

ALTER DEFAULT PRIVILEGES FOR ROLE egas_phase7_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO egas_phase7_app;
ALTER DEFAULT PRIVILEGES FOR ROLE egas_phase7_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO egas_phase7_app;

\echo 'Synthetic v5 hierarchy/reference seed complete.'
\echo 'Next: import and activate EGAS_2026_SYNTHETIC_VALID.xlsx using operator admin.local.'

-- LOCAL DEVELOPMENT SEED ONLY (supabase db reset). Never applied to staging or production.
-- Throwaway passwords for the local Docker database; production passwords come from the operator.
alter role recover_web password 'recover_web_dev';
alter role recover_worker password 'recover_worker_dev';

-- District policy: every global switch on so the local stack exercises every flow.
insert into public.district_settings (id, staff_email_domains, student_posting_global_enabled, lost_reports_global_enabled,
                                      cross_school_search_global_enabled, screening_enabled, lost_report_ttl_days)
values (1, '{recover.test}', true, true, true, true, 60)
on conflict (id) do update set staff_email_domains = excluded.staff_email_domains,
  student_posting_global_enabled = true, lost_reports_global_enabled = true,
  cross_school_search_global_enabled = true, screening_enabled = true;

-- Fixed UUID prefixes per school so tenant-crossing tests can build School-B references deterministically.
insert into public.schools (id, code, name, timezone, student_posting_enabled, lost_reports_enabled, cross_school_search_enabled, retention_days) values
  ('0a0a0a0a-0000-4000-8000-000000000001', 'FCHS', 'Forsyth Central High School', 'America/New_York', true, true, true, 30),
  ('0b0b0b0b-0000-4000-8000-000000000002', 'SFHS', 'South Forsyth High School', 'America/New_York', true, true, true, 30),
  ('0c0c0c0c-0000-4000-8000-000000000003', 'NFMS', 'North Forsyth Middle School', 'America/New_York', true, false, false, 21);

insert into public.locations (id, school_id, code, name, hours) values
  ('0a0a0a0a-1000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001', 'W', 'West Campus Office', 'School days 7:30 am - 4:30 pm'),
  ('0a0a0a0a-1000-4000-8000-000000000002', '0a0a0a0a-0000-4000-8000-000000000001', 'E', 'East Front Office', 'School days 7:15 am - 4:00 pm'),
  ('0a0a0a0a-1000-4000-8000-000000000003', '0a0a0a0a-0000-4000-8000-000000000001', 'STUB', 'Student Union Booth', 'Lunch periods only'),
  ('0b0b0b0b-1000-4000-8000-000000000001', '0b0b0b0b-0000-4000-8000-000000000002', 'M', 'Main Office', 'School days 7:30 am - 4:30 pm'),
  ('0b0b0b0b-1000-4000-8000-000000000002', '0b0b0b0b-0000-4000-8000-000000000002', 'A', 'Athletics Office', 'School days 2:30 pm - 6:00 pm'),
  ('0c0c0c0c-1000-4000-8000-000000000001', '0c0c0c0c-0000-4000-8000-000000000003', 'F', 'Front Office', 'School days 7:45 am - 4:15 pm');

-- Staff: one district admin, admins per school, office and reviewer at FCHS, and one multi-school user.
insert into public.staff_users (id, email, display_name) values
  ('00000000-5a00-4000-8000-000000000001', 'admin@recover.test', 'District Admin'),
  ('00000000-5a00-4000-8000-000000000002', 'principal.fchs@recover.test', 'FCHS School Admin'),
  ('00000000-5a00-4000-8000-000000000003', 'office.fchs@recover.test', 'FCHS Office'),
  ('00000000-5a00-4000-8000-000000000004', 'reviewer.fchs@recover.test', 'FCHS Reviewer'),
  ('00000000-5a00-4000-8000-000000000005', 'multi@recover.test', 'Multi-school Reviewer'),
  ('00000000-5a00-4000-8000-000000000006', 'admin.sfhs@recover.test', 'SFHS School Admin'),
  ('00000000-5a00-4000-8000-000000000007', 'admin.nfms@recover.test', 'NFMS School Admin');

insert into public.staff_members (id, user_id, school_id, role, status) values
  ('00000000-5b00-4000-8000-000000000001', '00000000-5a00-4000-8000-000000000001', null, 'district_admin', 'invited'),
  ('00000000-5b00-4000-8000-000000000002', '00000000-5a00-4000-8000-000000000002', '0a0a0a0a-0000-4000-8000-000000000001', 'school_admin', 'invited'),
  ('00000000-5b00-4000-8000-000000000003', '00000000-5a00-4000-8000-000000000003', '0a0a0a0a-0000-4000-8000-000000000001', 'office', 'invited'),
  ('00000000-5b00-4000-8000-000000000004', '00000000-5a00-4000-8000-000000000004', '0a0a0a0a-0000-4000-8000-000000000001', 'reviewer', 'invited'),
  ('00000000-5b00-4000-8000-000000000005', '00000000-5a00-4000-8000-000000000005', '0a0a0a0a-0000-4000-8000-000000000001', 'reviewer', 'invited'),
  ('00000000-5b00-4000-8000-000000000006', '00000000-5a00-4000-8000-000000000005', '0b0b0b0b-0000-4000-8000-000000000002', 'office', 'invited'),
  ('00000000-5b00-4000-8000-000000000007', '00000000-5a00-4000-8000-000000000006', '0b0b0b0b-0000-4000-8000-000000000002', 'school_admin', 'invited'),
  ('00000000-5b00-4000-8000-000000000008', '00000000-5a00-4000-8000-000000000007', '0c0c0c0c-0000-4000-8000-000000000003', 'school_admin', 'invited');

-- Approved, active campus maps. The images themselves are uploaded by scripts/dev-seed-media.mjs.
insert into public.map_versions (id, school_id, public_storage_path, width_px, height_px, approval_status, active,
                                 created_by, submitted_at, approved_by, approved_at) values
  ('0a0a0a0a-2000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001',
   '0a0a0a0a-0000-4000-8000-000000000001/0a0a0a0a-2000-4000-8000-000000000001/5eed0000000000000000000000000001.jpg',
   1600, 1000, 'approved', true, '00000000-5b00-4000-8000-000000000002', now(), '00000000-5b00-4000-8000-000000000001', now()),
  ('0b0b0b0b-2000-4000-8000-000000000001', '0b0b0b0b-0000-4000-8000-000000000002',
   '0b0b0b0b-0000-4000-8000-000000000002/0b0b0b0b-2000-4000-8000-000000000001/5eed0000000000000000000000000002.jpg',
   1600, 1000, 'approved', true, '00000000-5b00-4000-8000-000000000007', now(), '00000000-5b00-4000-8000-000000000001', now()),
  ('0c0c0c0c-2000-4000-8000-000000000001', '0c0c0c0c-0000-4000-8000-000000000003',
   '0c0c0c0c-0000-4000-8000-000000000003/0c0c0c0c-2000-4000-8000-000000000001/5eed0000000000000000000000000003.jpg',
   1600, 1000, 'approved', true, '00000000-5b00-4000-8000-000000000008', now(), '00000000-5b00-4000-8000-000000000001', now());

-- Zones must be inserted while their version is still a draft (G-07 freeze), so insert zones for
-- the approved maps by temporarily flipping them to draft inside this seed transaction.
update public.map_versions set approval_status = 'draft', active = false, public_storage_path = null,
       approved_by = null, approved_at = null
 where id in ('0a0a0a0a-2000-4000-8000-000000000001', '0b0b0b0b-2000-4000-8000-000000000001', '0c0c0c0c-2000-4000-8000-000000000001');

insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius)
select s.school_id, s.map_version_id, z.name, z.cx, z.cy, z.radius
  from (values
    ('0a0a0a0a-0000-4000-8000-000000000001'::uuid, '0a0a0a0a-2000-4000-8000-000000000001'::uuid),
    ('0b0b0b0b-0000-4000-8000-000000000002'::uuid, '0b0b0b0b-2000-4000-8000-000000000001'::uuid),
    ('0c0c0c0c-0000-4000-8000-000000000003'::uuid, '0c0c0c0c-2000-4000-8000-000000000001'::uuid)
  ) as s(school_id, map_version_id)
  cross join (values
    ('Main Hall', 0.30, 0.40, 0.14),
    ('Cafeteria', 0.62, 0.35, 0.12),
    ('Library', 0.45, 0.70, 0.10),
    ('Gym', 0.82, 0.62, 0.14),
    ('Bus Loop', 0.15, 0.85, 0.12)
  ) as z(name, cx, cy, radius);

update public.map_versions v
   set approval_status = 'approved', active = true,
       public_storage_path = v.school_id::text || '/' || v.id::text || '/5eed000000000000000000000000000'
                             || case v.school_id when '0a0a0a0a-0000-4000-8000-000000000001' then '1'
                                                 when '0b0b0b0b-0000-4000-8000-000000000002' then '2' else '3' end || '.jpg',
       approved_by = '00000000-5b00-4000-8000-000000000001', approved_at = now()
 where id in ('0a0a0a0a-2000-4000-8000-000000000001', '0b0b0b0b-2000-4000-8000-000000000001', '0c0c0c0c-2000-4000-8000-000000000001');

insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y) values
  ('0a0a0a0a-0000-4000-8000-000000000001', '0a0a0a0a-1000-4000-8000-000000000001', '0a0a0a0a-2000-4000-8000-000000000001', 0.12, 0.30),
  ('0a0a0a0a-0000-4000-8000-000000000001', '0a0a0a0a-1000-4000-8000-000000000002', '0a0a0a0a-2000-4000-8000-000000000001', 0.88, 0.25),
  ('0a0a0a0a-0000-4000-8000-000000000001', '0a0a0a0a-1000-4000-8000-000000000003', '0a0a0a0a-2000-4000-8000-000000000001', 0.55, 0.50),
  ('0b0b0b0b-0000-4000-8000-000000000002', '0b0b0b0b-1000-4000-8000-000000000001', '0b0b0b0b-2000-4000-8000-000000000001', 0.20, 0.30),
  ('0b0b0b0b-0000-4000-8000-000000000002', '0b0b0b0b-1000-4000-8000-000000000002', '0b0b0b0b-2000-4000-8000-000000000001', 0.80, 0.70),
  ('0c0c0c0c-0000-4000-8000-000000000003', '0c0c0c0c-1000-4000-8000-000000000001', '0c0c0c0c-2000-4000-8000-000000000001', 0.25, 0.35);

-- Operating calendar: weekdays open 07:30-16:30 from a week ago through ~150 days ahead (F-88 horizon).
insert into public.school_calendar_days (school_id, day, is_open, open_at, close_at, source)
select s.id, d::date,
       extract(isodow from d) < 6,
       case when extract(isodow from d) < 6 then time '07:30' end,
       case when extract(isodow from d) < 6 then time '16:30' end,
       'seed'
  from public.schools s
  cross join generate_series(current_date - 7, current_date + 150, interval '1 day') as d;

-- A small district vocabulary; the full list is loaded from packages/shared/src/synonyms.json.
insert into public.synonyms (term, expansions) values
  ('hydroflask', '{water bottle,bottle}'),
  ('stanley', '{tumbler,water bottle}'),
  ('airpods', '{earbuds,headphones}'),
  ('chromebook', '{laptop}'),
  ('botella', '{bottle,water bottle}'),
  ('mochila', '{backpack,bag}'),
  ('sudadera', '{hoodie,sweatshirt}')
on conflict (term) do nothing;

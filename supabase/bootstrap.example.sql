-- Production/staging bootstrap (run ONCE after `supabase db push`, as the postgres admin).
-- Copy to a private location, replace every <placeholder>, run with psql. Never commit the filled copy.
begin;

insert into public.district_settings (id, staff_email_domains, lost_report_ttl_days,
  student_posting_global_enabled, lost_reports_global_enabled, cross_school_search_global_enabled,
  screening_enabled, screening_daily_ceiling, retention_days_floor, retention_days_ceiling)
values (1, '{<district staff email domain, e.g. district.k12.ga.us>}', 60,
  false, false, false,          -- global switches stay OFF until Appendix J evidence exists (§0.3)
  true, 500, 14, 60)
on conflict (id) do nothing;

-- First district admin (signs in with Google; the invitation binds on first sign-in, F-45).
with u as (
  insert into public.staff_users (email, display_name)
  values (lower('<district.admin@district domain>'), '<Display Name>')
  returning id
)
insert into public.staff_members (user_id, school_id, role, status)
select id, null, 'district_admin', 'invited' from u;

commit;

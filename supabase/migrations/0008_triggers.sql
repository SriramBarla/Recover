-- 0008 triggers: timestamps, row versions, retention bounds (F-64), code immutability,
-- zone freeze (G-07), audit append-only, and the §7.7 database-level state assertions.
set lock_timeout = '5s';
set statement_timeout = '60s';

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function private.bump_row_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.row_version := old.row_version + 1;
  return new;
end $$;

create trigger schools_touch before update on public.schools for each row execute function private.touch_updated_at();
create trigger district_settings_touch before update on public.district_settings for each row execute function private.touch_updated_at();
create trigger staff_members_touch before update on public.staff_members for each row execute function private.touch_updated_at();
create trigger locations_touch before update on public.locations for each row execute function private.touch_updated_at();
create trigger items_touch before update on public.items for each row execute function private.touch_updated_at();
create trigger items_version before update on public.items for each row execute function private.bump_row_version();
create trigger item_photos_touch before update on public.item_photos for each row execute function private.touch_updated_at();
create trigger lost_reports_touch before update on public.lost_reports for each row execute function private.touch_updated_at();
create trigger lost_reports_version before update on public.lost_reports for each row execute function private.bump_row_version();

-- F-64: school retention must stay inside the district floor/ceiling on every write path.
create function private.check_school_retention() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_floor int;
  v_ceiling int;
begin
  select retention_days_floor, retention_days_ceiling into v_floor, v_ceiling
    from public.district_settings where id = 1;
  if v_floor is not null and (new.retention_days < v_floor or new.retention_days > v_ceiling) then
    raise exception using errcode = 'RV001', message = 'invalid_input', detail = 'retention_days';
  end if;
  return new;
end $$;
create trigger schools_retention before insert or update of retention_days on public.schools
  for each row execute function private.check_school_retention();

create function private.check_district_retention() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.schools s
              where s.retention_days < new.retention_days_floor or s.retention_days > new.retention_days_ceiling) then
    raise exception using errcode = 'RV001', message = 'invalid_input', detail = 'retention_days_floor';
  end if;
  return new;
end $$;
create trigger district_retention before update of retention_days_floor, retention_days_ceiling on public.district_settings
  for each row execute function private.check_district_retention();

-- §4: school codes are immutable once created (they are printed on QR posters and public IDs).
create function private.school_code_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.code is distinct from old.code then
    raise exception using errcode = 'RV001', message = 'invalid_input', detail = 'code';
  end if;
  return new;
end $$;
create trigger schools_code_immutable before update of code on public.schools
  for each row execute function private.school_code_immutable();

-- G-07: zones are part of the district-approved package; frozen once the version leaves draft.
create function private.zones_frozen() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_status text;
begin
  select approval_status into v_status from public.map_versions
   where id = coalesce(new.map_version_id, old.map_version_id);
  if v_status is distinct from 'draft' then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'zones_frozen';
  end if;
  return coalesce(new, old);
end $$;
create trigger map_zones_frozen before insert or update or delete on public.map_zones
  for each row execute function private.zones_frozen();

-- Audit rows are append-only for every role; the only escape hatch is an explicit retention migration.
create function private.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('recover.audit_retention', true), '') <> 'on' then
    raise exception 'audit_log is append-only';
  end if;
  return coalesce(new, old);
end $$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function private.audit_append_only();

-- §7.7 assertions not expressible as CHECKs.
create function private.items_state_assertions() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_terminal constant public.custody_status[] :=
    array['claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived']::public.custody_status[];
  v_current int;
  v_not_ready int;
begin
  -- terminal custody is immutable, except the audited late-arrival path (G-01).
  if old.custody = any (v_terminal) and new.custody is distinct from old.custody
     and not (old.custody = 'expired_never_arrived' and new.custody = 'at_location') then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'terminal_custody_immutable';
  end if;

  -- published requires every current photo generation to have ready public variants (F-18).
  if new.publication_status = 'published' and old.publication_status is distinct from 'published' then
    select count(*), count(*) filter (where p.status <> 'public_ready')
      into v_current, v_not_ready
      from public.item_photos p
     where p.item_id = new.id and p.is_current;
    if v_current = 0 or v_not_ready > 0 then
      raise exception using errcode = 'RV001', message = 'state_changed', detail = 'published_requires_ready_variants';
    end if;
  end if;

  -- anonymization and text clearing are one-way.
  if old.content_anonymized_at is not null and
     (new.content_anonymized_at is null or new.description is not null or new.location_note_private is not null
      or new.pin_x is not null or new.src is not null) then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'anonymization_one_way';
  end if;
  if old.text_cleared_at is not null and
     (new.text_cleared_at is null or new.description is not null or new.location_note_private is not null) then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'text_clearing_one_way';
  end if;

  -- tenant and identity columns never change after insert.
  if new.school_id is distinct from old.school_id or new.posted_by_kind is distinct from old.posted_by_kind
     or (old.public_id is not null and new.public_id is distinct from old.public_id) then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'immutable_column';
  end if;
  return new;
end $$;
create trigger items_state_assertions before update on public.items
  for each row execute function private.items_state_assertions();

create function private.lost_reports_state_assertions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'open' and new.status = 'open' then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'report_terminal_immutable';
  end if;
  if old.content_cleared_at is not null and (new.content_cleared_at is null or new.description is not null) then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'report_clearing_one_way';
  end if;
  if new.school_id is distinct from old.school_id then
    raise exception using errcode = 'RV001', message = 'state_changed', detail = 'immutable_column';
  end if;
  return new;
end $$;
create trigger lost_reports_state_assertions before update on public.lost_reports
  for each row execute function private.lost_reports_state_assertions();

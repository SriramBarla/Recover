-- 0011 G-01: recompute open arrival deadlines when the operating calendar or the school's
-- never-arrived setting changes (for example an emergency closure added after an item was posted).
-- Only items still with the finder and past draft are touched; terminal items never change (§7.7).
set lock_timeout = '5s';
set statement_timeout = '60s';

create function private.recompute_arrival_deadlines(p_school_id uuid default null) returns int
language plpgsql set search_path = '' as $$
declare
  v_n int;
begin
  update public.items i
     set arrival_deadline_at = private.calendar_next_close(i.school_id, i.created_at, s.never_arrived_school_days)
    from public.schools s
   where s.id = i.school_id
     and (p_school_id is null or i.school_id = p_school_id)
     and i.custody = 'with_finder'
     and i.review_status in ('pending', 'approved')
     and i.deleted_at is null
     and i.arrival_deadline_at is distinct from
         private.calendar_next_close(i.school_id, i.created_at, s.never_arrived_school_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function private.calendar_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform private.recompute_arrival_deadlines(null);
  return null;
end $$;

create function private.school_deadline_settings_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.never_arrived_school_days is distinct from old.never_arrived_school_days
     or new.timezone is distinct from old.timezone then
    perform private.recompute_arrival_deadlines(new.id);
  end if;
  return null;
end $$;

create trigger school_calendar_recompute
  after insert or update or delete on public.school_calendar_days
  for each statement execute function private.calendar_changed();

create trigger schools_deadline_recompute
  after update of never_arrived_school_days, timezone on public.schools
  for each row execute function private.school_deadline_settings_changed();

revoke all on function private.recompute_arrival_deadlines(uuid) from public;
grant execute on function private.recompute_arrival_deadlines(uuid) to recover_api_owner, recover_system_owner;

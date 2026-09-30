-- 0011 G-01: extend open arrival deadlines when a school's operating calendar or its never-arrived setting
-- changes, for example an emergency closure added after an item was posted. /complete promises the finder a
-- deadline (04 §6.1), so a recompute only ever moves it later or fills one that missing calendar coverage left
-- NULL. It never moves it earlier. Only the edited school's items are touched, and only those still with the
-- finder and past draft. Terminal items never change (§7.7).
set lock_timeout = '5s';
set statement_timeout = '60s';

create function private.recompute_arrival_deadlines(p_school_ids uuid[]) returns int
language plpgsql set search_path = '' as $$
declare
  v_n int;
begin
  update public.items i
     set arrival_deadline_at = c.next_close
    from (select i2.id,
                 private.calendar_next_close(i2.school_id, coalesce(i2.arrival_basis_at, i2.created_at),
                                             s.never_arrived_school_days) as next_close
            from public.items i2
            join public.schools s on s.id = i2.school_id
           where i2.school_id = any (p_school_ids)
             and i2.custody = 'with_finder'
             and i2.review_status in ('pending', 'approved')
             and i2.deleted_at is null) c
   where i.id = c.id
     and c.next_close is not null
     and (i.arrival_deadline_at is null or c.next_close > i.arrival_deadline_at);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Statement triggers with transition tables: one recompute per edited school, however many days changed.
create function private.calendar_changed() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct n.school_id) into v_ids from new_days n;
  elsif tg_op = 'UPDATE' then
    select array_agg(distinct x.school_id) into v_ids
      from (select school_id from new_days union select school_id from old_days) x;
  else
    select array_agg(distinct o.school_id) into v_ids from old_days o;
  end if;
  if v_ids is not null then
    perform private.recompute_arrival_deadlines(v_ids);
  end if;
  return null;
end $$;

create function private.school_deadline_settings_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.never_arrived_school_days is distinct from old.never_arrived_school_days
     or new.timezone is distinct from old.timezone then
    perform private.recompute_arrival_deadlines(array[new.id]);
  end if;
  return null;
end $$;

create trigger school_calendar_recompute_insert
  after insert on public.school_calendar_days
  referencing new table as new_days
  for each statement execute function private.calendar_changed();

create trigger school_calendar_recompute_update
  after update on public.school_calendar_days
  referencing old table as old_days new table as new_days
  for each statement execute function private.calendar_changed();

create trigger school_calendar_recompute_delete
  after delete on public.school_calendar_days
  referencing old table as old_days
  for each statement execute function private.calendar_changed();

create trigger schools_deadline_recompute
  after update of never_arrived_school_days, timezone on public.schools
  for each row execute function private.school_deadline_settings_changed();

revoke all on function private.recompute_arrival_deadlines(uuid[]) from public;
grant execute on function private.recompute_arrival_deadlines(uuid[]) to recover_api_owner, recover_system_owner;

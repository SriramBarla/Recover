-- 0210 rate limits for the two unauthenticated counter endpoints (security review L1; §13.2; G-29, G-39).
-- Re-creates api_rate_take from 0200 with two IP-only actions:
--   high_value    POST /api/s/[code]/events/high-value: school-scoped like every other action, 20 per
--                 10 minutes per address;
--   client_error  POST /api/client-error: school-less, because the beacon has no school to name. Its
--                 counters live under the district tenant scope, 60 per 10 minutes per address.
-- A school-less action takes p_school_code null; every other action still derives its scope from the
-- school (G-39). The action is now checked before the school is resolved.
-- api_record_error also accepts a space: the web's server-side signatures are `<METHOD> <route>:<Class>`
-- (shared log.ts errorSignature), which the 0200 pattern refused, so none of them were ever counted.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- §13.2 fixed windows on rate_counters. tenant_scope is derived from the school (G-39), or is `district` for
-- a school-less action. The counter key carries the window label so the day and week windows of one action
-- never share a row. A NULL device (first visit, no cookie yet) applies only the IP limits; unknown or NULL
-- campus status is off-campus. Over any limit: rate_limited with the seconds until the latest exceeded window
-- ends; the raise rolls back this call's increments, so refused requests do not consume budget.
create or replace function public.api_rate_take(
  p_school_code text,
  p_action text,
  p_device_hmac bytea default null,
  p_ip_hmac bytea default null,
  p_on_campus boolean default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_scope text;
  v_campus boolean := coalesce(p_on_campus, false);
  l record;
  v_subject bytea;
  v_start timestamptz;
  v_count int;
  v_retry int := 0;
begin
  set local lock_timeout = '3s';
  if p_action is null or p_action not in ('post_item', 'lost_report', 'search', 'status_poll', 'search_all',
                                          'high_value', 'client_error') then
    perform private.fail('invalid_input', 'action');
  end if;
  if p_action = 'client_error' then
    if p_school_code is not null then
      perform private.fail('invalid_input', 'school_code');
    end if;
    v_scope := 'district';
  else
    s := private.school_by_code(p_school_code);
    v_scope := 'school:' || s.id::text;
  end if;
  if p_device_hmac is not null and octet_length(p_device_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'device_hmac');
  end if;
  if p_ip_hmac is not null and octet_length(p_ip_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'ip_hmac');
  end if;
  -- the IP-only actions have no device limit, so they need the address
  if (p_device_hmac is null or p_action in ('high_value', 'client_error')) and p_ip_hmac is null then
    perform private.fail('invalid_input', 'ip_hmac');
  end if;

  for l in
    with limits (action, subject_kind, campus, window_label, window_s, max_count) as (
      values
        -- §13.2 device limits
        ('post_item',   'device', null::boolean, '1d',  86400,  3),
        ('post_item',   'device', null,          '7d',  604800, 6),
        ('lost_report', 'device', null,          '1d',  86400,  1),
        ('search',      'device', null,          '10m', 600,    60),
        ('status_poll', 'device', null,          '10m', 600,    30),
        ('search_all',  'device', null,          '10m', 600,    60),
        -- §13.2 IP limits, per school: on-campus ranges vs everyone else (unknown = off-campus)
        ('post_item',   'ip',     true,          '1h',  3600,   300),
        ('post_item',   'ip',     false,         '1h',  3600,   10),
        ('search',      'ip',     true,          '10m', 600,    3000),
        ('search',      'ip',     false,         '10m', 600,    200),
        -- cross-school search has its own budget (Appendix B.2), sized like search
        ('search_all',  'ip',     true,          '10m', 600,    3000),
        ('search_all',  'ip',     false,         '10m', 600,    200),
        -- unauthenticated counters (security review L1): IP only, on or off campus
        ('high_value',   'ip',    null,          '10m', 600,    20),
        ('client_error', 'ip',    null,          '10m', 600,    60)
    )
    select lim.subject_kind, lim.window_label, lim.window_s, lim.max_count
      from limits lim
     where lim.action = p_action and (lim.campus is null or lim.campus = v_campus)
  loop
    v_subject := case l.subject_kind when 'device' then p_device_hmac else p_ip_hmac end;
    continue when v_subject is null;
    v_start := date_bin(make_interval(secs => l.window_s), now(), timestamptz '2001-01-01 00:00:00+00');
    insert into public.rate_counters as c (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
    values (v_scope, p_action || ':' || l.window_label, l.subject_kind, v_subject, v_start, 1)
    on conflict (tenant_scope, action, subject_kind, subject_hmac, window_start)
    do update set count = c.count + 1
    returning c.count into v_count;
    if v_count > l.max_count then
      v_retry := greatest(v_retry, 1,
        ceil(extract(epoch from (v_start + make_interval(secs => l.window_s) - now())))::int);
    end if;
  end loop;

  if v_retry > 0 then
    perform private.fail('rate_limited', v_retry::text);
  end if;
  return jsonb_build_object('ok', true);
end $$;
alter function public.api_rate_take(text, text, bytea, bytea, boolean) owner to recover_api_owner;
revoke all on function public.api_rate_take(text, text, bytea, bytea, boolean) from public;
grant execute on function public.api_rate_take(text, text, bytea, bytea, boolean) to recover_web;

-- G-29: error signatures (a route template plus an error class, no free text) counted per UTC day. The web
-- sends `<METHOD> <route template>:<Class>` for server errors and `client:<route template>:<Class>` for the
-- allowlisted browser beacon, so a single space is the only addition to the 0200 character set.
create or replace function public.api_record_error(p_signature text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  set local lock_timeout = '3s';
  if p_signature is null or p_signature !~ '^[A-Za-z0-9_:/.\[\] -]{1,120}$' then
    perform private.fail('invalid_input', 'signature');
  end if;
  insert into public.error_rollup as e (day, signature, count)
  values ((now() at time zone 'UTC')::date, p_signature, 1)
  on conflict (day, signature) do update set count = e.count + 1;
  return jsonb_build_object('ok', true);
end $$;
alter function public.api_record_error(text) owner to recover_api_owner;
revoke all on function public.api_record_error(text) from public;
grant execute on function public.api_record_error(text) to recover_web;

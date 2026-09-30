-- 0200 student and public API family (BUILD-CONTRACT section 6.1; §5.1, §5.2, §6, §7.2, §8.1, §11, §12, §13.2, Appendix C).
-- Every public.api_* function here: SECURITY DEFINER, search_path '', owner recover_api_owner, EXECUTE only to
-- recover_web. Responses are explicit jsonb_build_object DTOs with camelCase keys (§7.2 allowlist): never
-- to_jsonb(row), never select * into a response. Errors use private.fail with the section 4 codes only.
-- Helpers are private.student_* (SECURITY INVOKER, owner postgres); inside the api functions they run as
-- recover_api_owner. The file is re-runnable (create or replace throughout).
set lock_timeout = '5s';
set statement_timeout = '60s';

-- =====================================================================================================
-- private.student_* helpers
-- =====================================================================================================

-- §6.4: the device digest is version byte || HMAC-SHA256, exactly the 33 bytes the column CHECKs require.
create or replace function private.student_check_digest(p bytea) returns void
language plpgsql set search_path = '' as $$
begin
  if p is null or octet_length(p) <> 33 then
    perform private.fail('invalid_input', 'device_digest');
  end if;
end $$;

-- Category text -> enum without leaking a cast error (a bad value is invalid_input, not internal).
create or replace function private.student_category(p text) returns public.item_category
language plpgsql set search_path = '' as $$
begin
  if p is null then
    return null;
  end if;
  if not (p = any (enum_range(null::public.item_category)::text[])) then
    perform private.fail('invalid_input', 'category');
  end if;
  return p::public.item_category;
end $$;

-- F-102 defence in depth (the web cleans first): NFC, whitespace collapsed, C0/C1 and bidi controls rejected,
-- length bounded. p_min = 0 marks an optional field: NULL or blank returns NULL.
create or replace function private.student_clean_text(p text, p_min int, p_max int, p_field text) returns text
language plpgsql set search_path = '' as $$
declare
  v text;
begin
  if p is not null then
    v := btrim(regexp_replace(normalize(p, NFC), '\s+', ' ', 'g'));
  end if;
  if v is null or v = '' then
    if p_min > 0 then
      perform private.fail('invalid_input', p_field);
    end if;
    return null;
  end if;
  if v ~ '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]'
     or char_length(v) < p_min or char_length(v) > p_max then
    perform private.fail('invalid_input', p_field);
  end if;
  return v;
end $$;

-- §5.1 step 4: a pin is optional, both coordinates in [0, 1], and only on the school's ACTIVE approved map.
-- Returns the map version to store (NULL when there is no pin).
create or replace function private.student_check_pin(
  p_school_id uuid, p_map_version_id uuid, p_x double precision, p_y double precision
) returns uuid
language plpgsql set search_path = '' as $$
begin
  if p_x is null and p_y is null then
    return null;
  end if;
  -- NaN sorts above every number in Postgres, so the BETWEEN tests also reject NaN and infinities.
  if p_x is null or p_y is null or not (p_x between 0 and 1) or not (p_y between 0 and 1) then
    perform private.fail('invalid_input', 'pin');
  end if;
  if p_map_version_id is null or not exists (
       select 1 from public.map_versions v
        where v.id = p_map_version_id and v.school_id = p_school_id
          and v.active and v.approval_status = 'approved') then
    perform private.fail('invalid_input', 'map_version_id');
  end if;
  return p_map_version_id;
end $$;

-- Live funnel counters (F-63) keyed by the school-local day. Only the columns the device API owns.
create or replace function private.student_bump_stats(
  p_school_id uuid, p_timezone text,
  p_posted int default 0, p_lost_reports int default 0, p_matches_viewed int default 0,
  p_reports_closed_found int default 0, p_high_value_redirects int default 0
) returns void
language sql set search_path = '' as $$
  insert into public.daily_school_stats as d
         (school_id, day, posted, lost_reports, matches_viewed, reports_closed_found, high_value_redirects)
  values (p_school_id, (now() at time zone p_timezone)::date, p_posted, p_lost_reports, p_matches_viewed,
          p_reports_closed_found, p_high_value_redirects)
  on conflict (school_id, day) do update
     set posted               = d.posted + excluded.posted,
         lost_reports         = d.lost_reports + excluded.lost_reports,
         matches_viewed       = d.matches_viewed + excluded.matches_viewed,
         reports_closed_found = d.reports_closed_found + excluded.reports_closed_found,
         high_value_redirects = d.high_value_redirects + excluded.high_value_redirects
$$;

-- §11 / G-22: the query is normalized exactly like the indexed text (lowercase, unaccent, collapsed
-- whitespace), control characters removed, capped at 120 characters.
create or replace function private.student_query_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select left(private.search_norm(regexp_replace(left(coalesce(p, ''), 480), '[[:cntrl:]]', ' ', 'g')), 120)
$$;

-- §11.5: optional redacted normalized query (address-like tokens and digits masked), no device linkage.
create or replace function private.student_redact(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(regexp_replace(regexp_replace(coalesce(p, ''), '\S*[@:/]\S*', '[redacted]', 'g'),
                                    '[0-9]', '#', 'g'), 120), '')
$$;

-- §11.2 retrieval with the G-22 fixes. Candidates come only from public.visible_items.
--   tokens: at most 8 distinct tokens of 2+ characters; English stop words carry no signal and are dropped
--           unless they have synonyms.
--   FTS:    per token (plainto simple | plainto english | phraseto of each synonym expansion), groups ANDed.
--           search_tsv indexes f_unaccent(description), and the query is unaccented the same way.
--   trigram: word similarity (q <% search_norm(description), threshold 0.4) so items_trgm is usable.
-- Both ranked lists are fused by reciprocal rank (k = 60). Filters apply inside both branches so a filtered
-- search is not starved by the 40-row branch caps.
create or replace function private.student_search_hits(
  p_school_ids uuid[], p_norm text, p_location_id uuid, p_category public.item_category, p_limit int
) returns table (o_item_id uuid, o_school_id uuid, o_score numeric, o_created_at timestamptz)
language plpgsql set search_path = '' as $$
declare
  v_terms text[];
  v_trgm text;
  v_tsq tsquery;
  v_group tsquery;
  v_tok text;
  v_exp text;
begin
  select coalesce(array_agg(t.tok order by t.ord), '{}') into v_terms
    from (select c.tok, min(c.ord) as ord
            from (select regexp_replace(x.tok, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g') as tok, x.ord
                    from regexp_split_to_table(coalesce(p_norm, ''), ' ') with ordinality as x(tok, ord)) c
           where char_length(c.tok) >= 2
             and (length(to_tsvector('english', c.tok)) > 0
                  or exists (select 1 from public.synonyms s where s.term = c.tok))
           group by c.tok
           order by min(c.ord)
           limit 8) t;
  if cardinality(v_terms) = 0 then
    return;
  end if;
  v_trgm := array_to_string(v_terms, ' ');

  foreach v_tok in array v_terms loop
    v_group := plainto_tsquery('simple', v_tok);
    if length(to_tsvector('english', v_tok)) > 0 then
      v_group := v_group || plainto_tsquery('english', v_tok);
    end if;
    -- G-22: synonyms widen the token's OR group; they never narrow the query.
    for v_exp in
      select private.search_norm(e.x)
        from public.synonyms s
        cross join lateral unnest(s.expansions) as e(x)
       where s.term = v_tok
    loop
      if length(to_tsvector('simple', v_exp)) > 0 then
        v_group := v_group || phraseto_tsquery('simple', v_exp);
      end if;
      if length(to_tsvector('english', v_exp)) > 0 then
        v_group := v_group || phraseto_tsquery('english', v_exp);
      end if;
    end loop;
    if numnode(v_group) > 0 then
      v_tsq := case when v_tsq is null then v_group else v_tsq && v_group end;
    end if;
  end loop;

  set local pg_trgm.word_similarity_threshold = 0.4;

  return query
  with fts as (
    select i.id, i.school_id, i.created_at,
           row_number() over (order by ts_rank_cd(i.search_tsv, v_tsq) desc, i.created_at desc, i.id desc) as r
      from public.visible_items i
     where v_tsq is not null
       and i.school_id = any (p_school_ids)
       and i.search_tsv @@ v_tsq
       and (p_location_id is null or coalesce(i.current_location_id, i.dropoff_location_id) = p_location_id)
       and (p_category is null or i.category = p_category)
     order by r
     limit 40
  ), trg as (
    select i.id, i.school_id, i.created_at,
           row_number() over (order by extensions.word_similarity(v_trgm, private.search_norm(i.description)) desc,
                                       i.created_at desc, i.id desc) as r
      from public.visible_items i
     where i.school_id = any (p_school_ids)
       and v_trgm operator(extensions.<%) private.search_norm(i.description)
       and (p_location_id is null or coalesce(i.current_location_id, i.dropoff_location_id) = p_location_id)
       and (p_category is null or i.category = p_category)
     order by r
     limit 40
  )
  select u.id, u.school_id, sum(1.0 / (60 + u.r))::numeric, u.created_at
    from (select f.id, f.school_id, f.created_at, f.r from fts f
          union all
          select g.id, g.school_id, g.created_at, g.r from trg g) u
   group by u.id, u.school_id, u.created_at
   order by 3 desc, u.created_at desc, u.id desc
   limit greatest(coalesce(p_limit, 30), 1);
end $$;

-- PublicItemRow (BUILD-CONTRACT 6.1) from the §7.2 projection. Never a pin, note, device, screening or staff field.
-- Photos: current generation, public_ready, ordered by position (public_item_photos).
create or replace function private.student_item_json(p public.public_items) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'publicId', p.public_id,
    'category', p.category,
    'description', p.description,
    'zoneName', p.zone_name,
    'custody', p.custody,
    'foundAt', p.found_at,
    'receivedAt', p.received_at,
    'locationId', p.location_id,
    'rowVersion', p.row_version,
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('position', ph.position, 'thumbPath', ph.thumb_path,
                                          'mediumPath', ph.medium_path, 'width', ph.width, 'height', ph.height)
                       order by ph.position)
        from public.public_item_photos ph
       where ph.item_id = p.id and ph.school_id = p.school_id), '[]'::jsonb))
$$;

-- G-39 / F-77: tenant_scope is derived here from the school code; callers never supply it.
create or replace function private.student_idem_scope(
  p_school_code text, p_principal_kind text, p_operation text, p_principal_hmac bytea, p_key_hash bytea
) returns text
language plpgsql set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
begin
  if p_principal_kind is null or p_principal_kind not in ('device', 'staff', 'system', 'district') then
    perform private.fail('invalid_input', 'principal_kind');
  end if;
  if p_operation is null or p_operation !~ '^[a-z_.]{3,60}$' then
    perform private.fail('invalid_input', 'operation');
  end if;
  if p_principal_hmac is null or octet_length(p_principal_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'principal_hmac');
  end if;
  if p_key_hash is null or octet_length(p_key_hash) not between 16 and 64 then
    perform private.fail('invalid_input', 'key_hash');
  end if;
  return 'school:' || s.id::text;
end $$;

revoke all on function private.student_check_digest(bytea) from public;
revoke all on function private.student_category(text) from public;
revoke all on function private.student_clean_text(text, int, int, text) from public;
revoke all on function private.student_check_pin(uuid, uuid, double precision, double precision) from public;
revoke all on function private.student_bump_stats(uuid, text, int, int, int, int, int) from public;
revoke all on function private.student_query_norm(text) from public;
revoke all on function private.student_redact(text) from public;
revoke all on function private.student_search_hits(uuid[], text, uuid, public.item_category, int) from public;
revoke all on function private.student_item_json(public.public_items) from public;
revoke all on function private.student_idem_scope(text, text, text, bytea, bytea) from public;
grant execute on function private.student_check_digest(bytea) to recover_api_owner;
grant execute on function private.student_category(text) to recover_api_owner;
grant execute on function private.student_clean_text(text, int, int, text) to recover_api_owner;
grant execute on function private.student_check_pin(uuid, uuid, double precision, double precision) to recover_api_owner;
grant execute on function private.student_bump_stats(uuid, text, int, int, int, int, int) to recover_api_owner;
grant execute on function private.student_query_norm(text) to recover_api_owner;
grant execute on function private.student_redact(text) to recover_api_owner;
grant execute on function private.student_search_hits(uuid[], text, uuid, public.item_category, int) to recover_api_owner;
grant execute on function private.student_item_json(public.public_items) to recover_api_owner;
grant execute on function private.student_idem_scope(text, text, text, bytea, bytea) to recover_api_owner;

-- =====================================================================================================
-- Public reads (§7.2 implementation guide "read side")
-- =====================================================================================================

-- Meta: flags already ANDed with the district switches (§5.5); map = the ACTIVE approved version (a `maps` key).
create or replace function public.api_get_meta(p_school_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v_map_id uuid;
  v_map jsonb;
begin
  select v.id,
         jsonb_build_object('versionId', v.id, 'path', v.public_storage_path, 'width', v.width_px, 'height', v.height_px)
    into v_map_id, v_map
    from public.map_versions v
   where v.school_id = s.id and v.active and v.approval_status = 'approved';

  return jsonb_build_object(
    'school', jsonb_build_object(
      'id', s.id,
      'code', s.code,
      'name', s.name,
      'timezone', s.timezone,
      'flags', jsonb_build_object(
        'studentPosting', private.feature_on(s, 'student_posting'),
        'lostReports', private.feature_on(s, 'lost_reports'),
        'crossSchoolSearch', private.feature_on(s, 'cross_school_search')),
      'enabledCategories', to_jsonb(s.enabled_categories::text[])),
    'map', v_map,
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'code', l.code, 'name', l.name, 'hours', l.hours,
               'pin', case when p.location_id is null then null
                           else jsonb_build_object('x', p.pin_x, 'y', p.pin_y) end)
             order by l.name, l.id)
        from public.locations l
        left join public.location_map_pins p
          on p.location_id = l.id and p.school_id = l.school_id and p.map_version_id = v_map_id
       where l.school_id = s.id and l.active), '[]'::jsonb),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'cx', z.cx, 'cy', z.cy, 'radius', z.radius)
                       order by z.name, z.id)
        from public.map_zones z
       where z.school_id = s.id and z.map_version_id = v_map_id and z.active), '[]'::jsonb));
end $$;
alter function public.api_get_meta(text) owner to recover_api_owner;
revoke all on function public.api_get_meta(text) from public;
grant execute on function public.api_get_meta(text) to recover_web;

-- Feed (§5.2 step 1): visible items only, keyset (created_at desc, id desc) on items_feed, 30 per page.
create or replace function public.api_get_feed(
  p_school_code text,
  p_cursor_created timestamptz default null,
  p_cursor_id uuid default null,
  p_location_id uuid default null,
  p_category text default null,
  p_since timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v_cat public.item_category := private.student_category(p_category);
  v_ids uuid[];
  v_items jsonb;
  v_next jsonb;
begin
  if (p_cursor_created is null) <> (p_cursor_id is null) then
    perform private.fail('invalid_input', 'cursor');
  end if;

  v_ids := array(
    select pi.id
      from public.public_items pi
     where pi.school_id = s.id
       and (p_cursor_created is null or (pi.created_at, pi.id) < (p_cursor_created, p_cursor_id))
       and (p_location_id is null or pi.location_id = p_location_id)
       and (v_cat is null or pi.category = v_cat)
       and (p_since is null or pi.created_at >= p_since)
     order by pi.created_at desc, pi.id desc
     limit 31);

  if cardinality(v_ids) > 30 then
    v_ids := v_ids[1:30];
    select jsonb_build_object('createdAt', pi.created_at, 'id', pi.id) into v_next
      from public.public_items pi
     where pi.id = v_ids[30] and pi.school_id = s.id;
  end if;

  select coalesce(jsonb_agg(private.student_item_json(pi) order by pi.created_at desc, pi.id desc), '[]'::jsonb)
    into v_items
    from public.public_items pi
   where pi.school_id = s.id and pi.id = any (v_ids);

  return jsonb_build_object('items', v_items, 'nextCursor', v_next);
end $$;
alter function public.api_get_feed(text, timestamptz, uuid, uuid, text, timestamptz) owner to recover_api_owner;
revoke all on function public.api_get_feed(text, timestamptz, uuid, uuid, text, timestamptz) from public;
grant execute on function public.api_get_feed(text, timestamptz, uuid, uuid, text, timestamptz) to recover_web;

-- Listing (§5.2 step 3): not_found for anything that is not visible.
create or replace function public.api_get_item(p_school_code text, p_public_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v_pid text := upper(btrim(coalesce(p_public_id, '')));
  v jsonb;
begin
  if v_pid !~ '^[A-Z]{2,6}-[A-Z0-9]{1,6}-[0-9]{6,12}$' then
    perform private.fail('invalid_input', 'public_id');
  end if;
  select private.student_item_json(pi)
         || jsonb_build_object('location', jsonb_build_object('id', l.id, 'name', l.name, 'hours', l.hours))
    into v
    from public.public_items pi
    join public.locations l on l.id = pi.location_id and l.school_id = pi.school_id
   where pi.school_id = s.id and pi.public_id = v_pid;
  if v is null then
    perform private.fail('not_found');
  end if;
  return v;
end $$;
alter function public.api_get_item(text, text) owner to recover_api_owner;
revoke all on function public.api_get_item(text, text) from public;
grant execute on function public.api_get_item(text, text) to recover_web;

-- Search (§11, G-22): at most 30 fused rows from this school. One search_events row per query (§11.5):
-- query HMAC always, redacted text only when the district opts in; purge_after 90 days (the redacted text
-- is cleared earlier by the purge job).
create or replace function public.api_search(
  p_school_code text,
  p_q text,
  p_location_id uuid default null,
  p_category text default null,
  p_query_hmac bytea default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_cat public.item_category;
  v_norm text;
  v_items jsonb;
  v_count int;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  v_cat := private.student_category(p_category);
  v_norm := private.student_query_norm(p_q);
  if v_norm = '' then
    perform private.fail('invalid_input', 'q');
  end if;
  if p_query_hmac is null or octet_length(p_query_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'query_hmac');
  end if;

  select coalesce(jsonb_agg(private.student_item_json(pi) order by h.o_score desc, h.o_created_at desc, h.o_item_id desc),
                  '[]'::jsonb),
         count(*)
    into v_items, v_count
    from private.student_search_hits(array[s.id], v_norm, p_location_id, v_cat, 30) h
    join public.public_items pi on pi.id = h.o_item_id and pi.school_id = h.o_school_id;

  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, purge_after)
  values (s.id, p_query_hmac,
          case when (private.district()).redacted_search_enabled then private.student_redact(v_norm) end,
          v_count, now() + interval '90 days');

  return jsonb_build_object('items', v_items);
end $$;
alter function public.api_search(text, text, uuid, text, bytea) owner to recover_api_owner;
revoke all on function public.api_search(text, text, uuid, text, bytea) from public;
grant execute on function public.api_search(text, text, uuid, text, bytea) to recover_web;

-- Cross-school search (F-79): district switch AND source opt-in, and each target school's own opt-in.
-- Same retrieval as api_search; rows carry schoolCode. The event is attributed to the source school.
create or replace function public.api_search_all(p_from_code text, p_q text, p_query_hmac bytea) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_targets uuid[];
  v_norm text;
  v_items jsonb;
  v_count int;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_from_code);
  if not private.feature_on(s, 'cross_school_search') then
    perform private.fail('feature_disabled');
  end if;
  v_norm := private.student_query_norm(p_q);
  if v_norm = '' then
    perform private.fail('invalid_input', 'q');
  end if;
  if p_query_hmac is null or octet_length(p_query_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'query_hmac');
  end if;

  v_targets := array(
    select t.id from public.schools t
     where t.active and private.feature_on(t, 'cross_school_search'));

  select coalesce(jsonb_agg(private.student_item_json(pi) || jsonb_build_object('schoolCode', t.code)
                            order by h.o_score desc, h.o_created_at desc, h.o_item_id desc), '[]'::jsonb),
         count(*)
    into v_items, v_count
    from private.student_search_hits(v_targets, v_norm, null, null, 30) h
    join public.public_items pi on pi.id = h.o_item_id and pi.school_id = h.o_school_id
    join public.schools t on t.id = pi.school_id;

  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, purge_after)
  values (s.id, p_query_hmac,
          case when (private.district()).redacted_search_enabled then private.student_redact(v_norm) end,
          v_count, now() + interval '90 days');

  return jsonb_build_object('items', v_items);
end $$;
alter function public.api_search_all(text, text, bytea) owner to recover_api_owner;
revoke all on function public.api_search_all(text, text, bytea) from public;
grant execute on function public.api_search_all(text, text, bytea) to recover_web;

-- =====================================================================================================
-- Device state, rate limits, idempotency (§8 route skeleton steps 3, 4, 6)
-- =====================================================================================================

create or replace function public.api_device_touch(p_school_code text, p_device_digest bytea) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_until timestamptz;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);
  insert into public.devices as d (school_id, token_hash)
  values (s.id, p_device_digest)
  on conflict (school_id, token_hash) do update set last_seen_at = now()
  returning d.blocked_until into v_until;
  return jsonb_build_object(
    'blocked', coalesce(v_until > now(), false),
    'blockedUntil', case when v_until > now() then v_until end);
end $$;
alter function public.api_device_touch(text, bytea) owner to recover_api_owner;
revoke all on function public.api_device_touch(text, bytea) from public;
grant execute on function public.api_device_touch(text, bytea) to recover_web;

-- §13.2 fixed windows on rate_counters. tenant_scope is derived from the school (G-39). The counter key
-- carries the window label so the day and week windows of one action never share a row. A NULL device
-- (first visit, no cookie yet) applies only the IP limits; unknown or NULL campus status is off-campus.
-- Over any limit: rate_limited with the seconds until the latest exceeded window ends; the raise rolls
-- back this call's increments, so refused requests do not consume budget.
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
  s := private.school_by_code(p_school_code);
  if p_action is null or p_action not in ('post_item', 'lost_report', 'search', 'status_poll', 'search_all') then
    perform private.fail('invalid_input', 'action');
  end if;
  if p_device_hmac is not null and octet_length(p_device_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'device_hmac');
  end if;
  if p_ip_hmac is not null and octet_length(p_ip_hmac) not between 16 and 64 then
    perform private.fail('invalid_input', 'ip_hmac');
  end if;
  if p_device_hmac is null and p_ip_hmac is null then
    perform private.fail('invalid_input', 'ip_hmac');
  end if;
  v_scope := 'school:' || s.id::text;

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
        ('search_all',  'ip',     false,         '10m', 600,    200)
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

-- F-77 / G-39. 24 h TTL. Same key + same request: replay a stored response, or report in_progress while a
-- response-less row is under 60 s old (an older one is a crashed attempt and is taken over). Same key +
-- different request hash: idempotency_conflict. An expired row that was not purged yet is reused as new.
create or replace function public.api_idempotency_begin(
  p_school_code text, p_principal_kind text, p_operation text,
  p_principal_hmac bytea, p_key_hash bytea, p_request_hash bytea
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text;
  v_request bytea;
  v_code int;
  v_body jsonb;
  v_created timestamptz;
  v_expires timestamptz;
begin
  set local lock_timeout = '3s';
  v_scope := private.student_idem_scope(p_school_code, p_principal_kind, p_operation, p_principal_hmac, p_key_hash);
  if p_request_hash is null or octet_length(p_request_hash) not between 16 and 64 then
    perform private.fail('invalid_input', 'request_hash');
  end if;

  insert into public.idempotency_keys (tenant_scope, principal_kind, operation, principal_hmac, key_hash,
                                       request_hash, expires_at)
  values (v_scope, p_principal_kind, p_operation, p_principal_hmac, p_key_hash, p_request_hash,
          now() + interval '24 hours')
  on conflict (tenant_scope, principal_kind, operation, principal_hmac, key_hash) do nothing;
  if found then
    return jsonb_build_object('state', 'new', 'responseCode', null, 'responseBody', null);
  end if;

  select k.request_hash, k.response_code, k.response_body, k.created_at, k.expires_at
    into v_request, v_code, v_body, v_created, v_expires
    from public.idempotency_keys k
   where k.tenant_scope = v_scope and k.principal_kind = p_principal_kind and k.operation = p_operation
     and k.principal_hmac = p_principal_hmac and k.key_hash = p_key_hash
   for update;

  if v_expires <= now() then
    update public.idempotency_keys k
       set request_hash = p_request_hash, response_code = null, response_body = null,
           created_at = now(), expires_at = now() + interval '24 hours'
     where k.tenant_scope = v_scope and k.principal_kind = p_principal_kind and k.operation = p_operation
       and k.principal_hmac = p_principal_hmac and k.key_hash = p_key_hash;
    return jsonb_build_object('state', 'new', 'responseCode', null, 'responseBody', null);
  end if;
  if v_request <> p_request_hash then
    perform private.fail('idempotency_conflict');
  end if;
  if v_code is not null then
    return jsonb_build_object('state', 'replay', 'responseCode', v_code, 'responseBody', v_body);
  end if;
  if v_created > now() - interval '60 seconds' then
    return jsonb_build_object('state', 'in_progress', 'responseCode', null, 'responseBody', null);
  end if;
  update public.idempotency_keys k
     set created_at = now()
   where k.tenant_scope = v_scope and k.principal_kind = p_principal_kind and k.operation = p_operation
     and k.principal_hmac = p_principal_hmac and k.key_hash = p_key_hash;
  return jsonb_build_object('state', 'new', 'responseCode', null, 'responseBody', null);
end $$;
alter function public.api_idempotency_begin(text, text, text, bytea, bytea, bytea) owner to recover_api_owner;
revoke all on function public.api_idempotency_begin(text, text, text, bytea, bytea, bytea) from public;
grant execute on function public.api_idempotency_begin(text, text, text, bytea, bytea, bytea) to recover_web;

-- Stores the minimal replay DTO once; a second finish for the same key is a no-op.
create or replace function public.api_idempotency_finish(
  p_school_code text, p_principal_kind text, p_operation text,
  p_principal_hmac bytea, p_key_hash bytea, p_response_code int, p_response_body jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text;
begin
  set local lock_timeout = '3s';
  v_scope := private.student_idem_scope(p_school_code, p_principal_kind, p_operation, p_principal_hmac, p_key_hash);
  if p_response_code is null or p_response_code not between 100 and 599 then
    perform private.fail('invalid_input', 'response_code');
  end if;
  if p_response_body is not null and octet_length(p_response_body::text) > 16384 then
    perform private.fail('invalid_input', 'response_body');
  end if;

  update public.idempotency_keys k
     set response_code = p_response_code, response_body = p_response_body
   where k.tenant_scope = v_scope and k.principal_kind = p_principal_kind and k.operation = p_operation
     and k.principal_hmac = p_principal_hmac and k.key_hash = p_key_hash
     and k.response_code is null;
  if not found and not exists (
       select 1 from public.idempotency_keys k
        where k.tenant_scope = v_scope and k.principal_kind = p_principal_kind and k.operation = p_operation
          and k.principal_hmac = p_principal_hmac and k.key_hash = p_key_hash) then
    perform private.fail('not_found');
  end if;
  return jsonb_build_object('ok', true);
end $$;
alter function public.api_idempotency_finish(text, text, text, bytea, bytea, int, jsonb) owner to recover_api_owner;
revoke all on function public.api_idempotency_finish(text, text, text, bytea, bytea, int, jsonb) from public;
grant execute on function public.api_idempotency_finish(text, text, text, bytea, bytea, int, jsonb) to recover_web;

-- =====================================================================================================
-- Student posting (§5.1; Appendix C item_complete; G-01, G-03, G-11, G-32, G-37, G-38; F-17, F-99, F-102)
-- =====================================================================================================

-- Creates the draft and its generation-1 photo slots. Nothing here is visible to anyone but staff until a
-- human approves it and it is published. Duplicate text from the same device within 30 days is a reviewer
-- flag, never an auto-reject (G-11).
create or replace function public.api_create_item_draft(
  p_school_code text,
  p_device_digest bytea,
  p_category text,
  p_description text,
  p_note text default null,
  p_map_version_id uuid default null,
  p_pin_x double precision default null,
  p_pin_y double precision default null,
  p_dropoff_location_id uuid default null,
  p_photo_count int default null,
  p_src text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_cat public.item_category;
  v_desc text;
  v_note text;
  v_map uuid;
  v_zone uuid;
  v_flags jsonb := '{}'::jsonb;
  v_item uuid;
  v_photos jsonb;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);
  if not private.feature_on(s, 'student_posting') then
    perform private.fail('feature_disabled');
  end if;
  if exists (select 1 from public.devices d
              where d.school_id = s.id and d.token_hash = p_device_digest and d.blocked_until > now()) then
    perform private.fail('device_blocked');
  end if;

  v_cat := private.student_category(p_category);
  -- §5.1 step 2: high-value categories never create a student row; only the school's enabled categories.
  if v_cat is null or v_cat in ('phone', 'wallet', 'keys', 'id_card', 'medication')
     or not (v_cat = any (s.enabled_categories)) then
    perform private.fail('invalid_input', 'category');
  end if;
  v_desc := private.student_clean_text(p_description, 2, 120, 'description');
  v_note := private.student_clean_text(p_note, 0, 80, 'note');
  v_map := private.student_check_pin(s.id, p_map_version_id, p_pin_x, p_pin_y);
  if p_dropoff_location_id is null or not exists (
       select 1 from public.locations l
        where l.id = p_dropoff_location_id and l.school_id = s.id and l.active) then
    perform private.fail('invalid_input', 'dropoff_location_id');
  end if;
  if p_photo_count is null or p_photo_count not between 1 and 3 then
    perform private.fail('invalid_input', 'photo_count');
  end if;
  if p_src is not null and p_src !~ '^[a-z0-9][a-z0-9_-]{0,31}$' then
    perform private.fail('invalid_input', 'src');
  end if;

  if v_map is not null then
    v_zone := private.resolve_zone(v_map, p_pin_x, p_pin_y);
  end if;
  if exists (select 1 from public.items i
              where i.school_id = s.id and i.device_token_hash = p_device_digest
                and i.review_status <> 'draft' and i.created_at > now() - interval '30 days'
                and private.search_norm(i.description) = private.search_norm(v_desc)) then
    v_flags := jsonb_build_object('duplicate', true);
  end if;

  insert into public.items (school_id, category, description, location_note_private, zone_id, map_version_id,
                            pin_x, pin_y, dropoff_location_id, photo_count, review_status, publication_status,
                            custody, posted_by_kind, device_token_hash, src, screening_flags)
  values (s.id, v_cat, v_desc, v_note, v_zone, v_map,
          case when v_map is not null then p_pin_x end, case when v_map is not null then p_pin_y end,
          p_dropoff_location_id, p_photo_count, 'draft', 'hidden',
          'with_finder', 'student', p_device_digest, p_src, v_flags)
  returning id into v_item;

  -- G-37: generation 1 is current from the start; keys are server-generated (BUILD-CONTRACT section 8).
  with ins as (
    insert into public.item_photos (id, school_id, item_id, position, generation, is_current, incoming_path)
    select g.pid, s.id, v_item, g.pos, 1, true, s.id::text || '/' || v_item::text || '/' || g.pid::text || '/raw'
      from (select gen_random_uuid() as pid, n::smallint as pos
              from generate_series(0, p_photo_count - 1) as n) g
    returning item_photos.id, item_photos.position, item_photos.generation
  )
  select jsonb_agg(jsonb_build_object('photoId', ins.id, 'position', ins.position, 'generation', ins.generation)
                   order by ins.position)
    into v_photos
    from ins;

  insert into public.devices (school_id, token_hash)
  values (s.id, p_device_digest)
  on conflict (school_id, token_hash) do update set last_seen_at = now();

  return jsonb_build_object('itemId', v_item, 'photos', v_photos);
end $$;
alter function public.api_create_item_draft(text, bytea, text, text, text, uuid, double precision, double precision, uuid, int, text) owner to recover_api_owner;
revoke all on function public.api_create_item_draft(text, bytea, text, text, text, uuid, double precision, double precision, uuid, int, text) from public;
grant execute on function public.api_create_item_draft(text, bytea, text, text, text, uuid, double precision, double precision, uuid, int, text) to recover_web;

-- Appendix C item_complete: draft -> pending once every current photo passed the worker's coarse HEAD check.
-- Public id (§7.4), immutable arrival deadline (G-01: end of the next school day by default), raw_bytes (G-38),
-- canonicalize_photo outbox rows (F-23), audit and the posted counter, all in one transaction. A repeated
-- call after completion returns the same result.
create or replace function public.api_complete_item(
  p_school_code text, p_device_digest bytea, p_item_id uuid, p_objects jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_id uuid;
  v_status public.review_status;
  v_public text;
  v_deadline timestamptz;
  v_dropoff uuid;
  v_photos int;
  v_ok int;
  r record;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);

  select i.id, i.review_status, i.public_id, i.arrival_deadline_at, i.dropoff_location_id
    into v_id, v_status, v_public, v_deadline, v_dropoff
    from public.items i
   where i.id = p_item_id and i.school_id = s.id and i.posted_by_kind = 'student'
     and i.device_token_hash = p_device_digest
   for update;
  if v_id is null then
    perform private.fail('not_found');
  end if;
  if v_status <> 'draft' then
    return jsonb_build_object('itemId', v_id, 'publicId', v_public, 'reviewStatus', 'pending',
                              'arrivalDeadlineAt', v_deadline);
  end if;

  if not private.feature_on(s, 'student_posting') then
    perform private.fail('feature_disabled');
  end if;
  if exists (select 1 from public.devices d
              where d.school_id = s.id and d.token_hash = p_device_digest and d.blocked_until > now()) then
    perform private.fail('device_blocked');
  end if;

  -- Every current photo needs exactly one object entry: exists, magic bytes ok, 1..1048576 raw bytes.
  if p_objects is null or jsonb_typeof(p_objects) <> 'array' then
    perform private.fail('invalid_input', 'objects');
  end if;
  select count(*),
         count(*) filter (where exists (
           select 1 from jsonb_array_elements(p_objects) as o(e)
            where lower(o.e->>'photoId') = p.id::text
              and o.e->'exists' = 'true'::jsonb
              and o.e->'magicOk' = 'true'::jsonb
              and jsonb_typeof(o.e->'rawBytes') = 'number'
              and (o.e->>'rawBytes')::numeric between 1 and 1048576
              and (o.e->>'rawBytes')::numeric = trunc((o.e->>'rawBytes')::numeric)))
    into v_photos, v_ok
    from public.item_photos p
   where p.item_id = v_id and p.school_id = s.id and p.is_current;
  if v_photos = 0 or v_ok <> v_photos or jsonb_array_length(p_objects) <> v_photos then
    perform private.fail('invalid_input', 'objects');
  end if;

  v_public := private.next_public_id(s.id, v_dropoff);
  v_deadline := private.calendar_next_close(s.id, now(), s.never_arrived_school_days);

  update public.item_photos p
     set raw_bytes = (o.e->>'rawBytes')::int
    from jsonb_array_elements(p_objects) as o(e)
   where p.item_id = v_id and p.school_id = s.id and p.is_current and lower(o.e->>'photoId') = p.id::text;

  update public.items i
     set review_status = 'pending', public_id = v_public, arrival_deadline_at = v_deadline
   where i.id = v_id and i.school_id = s.id;

  for r in
    select p.id from public.item_photos p
     where p.item_id = v_id and p.school_id = s.id and p.is_current
     order by p.position
  loop
    perform private.enqueue('canonicalize_photo', jsonb_build_object('photoId', r.id), s.id,
                            'canonicalize_photo:' || r.id::text);
  end loop;

  perform private.audit(s.id, 'device', null, null, 'item.complete', 'items', v_id::text,
                        jsonb_build_object('review_status', 'draft'),
                        jsonb_build_object('review_status', 'pending', 'public_id', v_public),
                        jsonb_build_object('photo_count', v_photos));
  perform private.student_bump_stats(s.id, s.timezone, p_posted => 1);

  return jsonb_build_object('itemId', v_id, 'publicId', v_public, 'reviewStatus', 'pending',
                            'arrivalDeadlineAt', v_deadline);
end $$;
alter function public.api_complete_item(text, bytea, uuid, jsonb) owner to recover_api_owner;
revoke all on function public.api_complete_item(text, bytea, uuid, jsonb) from public;
grant execute on function public.api_complete_item(text, bytea, uuid, jsonb) to recover_web;

-- §8.1 status: only the posting device's digest within the same school (F-78). Minimal state, no moderation detail.
create or replace function public.api_item_status(p_school_code text, p_device_digest bytea, p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v jsonb;
begin
  perform private.student_check_digest(p_device_digest);
  select jsonb_build_object('itemId', i.id, 'publicId', i.public_id, 'reviewStatus', i.review_status,
                            'publicationStatus', i.publication_status, 'custody', i.custody,
                            'arrivalDeadlineAt', i.arrival_deadline_at)
    into v
    from public.items i
   where i.id = p_item_id and i.school_id = s.id and i.device_token_hash = p_device_digest
     and i.deleted_at is null;
  if v is null then
    perform private.fail('not_found');
  end if;
  return v;
end $$;
alter function public.api_item_status(text, bytea, uuid) owner to recover_api_owner;
revoke all on function public.api_item_status(text, bytea, uuid) from public;
grant execute on function public.api_item_status(text, bytea, uuid) to recover_web;

-- G-32: this device's own items at this school, last 60 days, not deleted, newest first, at most 50.
create or replace function public.api_my_items(p_school_code text, p_device_digest bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v jsonb;
begin
  perform private.student_check_digest(p_device_digest);
  select coalesce(jsonb_agg(jsonb_build_object('itemId', x.id, 'publicId', x.public_id, 'category', x.category,
                                               'createdAt', x.created_at, 'reviewStatus', x.review_status,
                                               'publicationStatus', x.publication_status, 'custody', x.custody)
                            order by x.created_at desc, x.id desc), '[]'::jsonb)
    into v
    from (select i.id, i.public_id, i.category, i.created_at, i.review_status, i.publication_status, i.custody
            from public.items i
           where i.school_id = s.id and i.device_token_hash = p_device_digest
             and i.created_at > now() - interval '60 days' and i.deleted_at is null
           order by i.created_at desc, i.id desc
           limit 50) x;
  return jsonb_build_object('items', v);
end $$;
alter function public.api_my_items(text, bytea) owner to recover_api_owner;
revoke all on function public.api_my_items(text, bytea) from public;
grant execute on function public.api_my_items(text, bytea) to recover_web;

-- =====================================================================================================
-- Lost reports on the device (§5.2 step 5, §6.2, §12.3, §12.4; Appendix C report_create/close/seen; F-63, F-78)
-- =====================================================================================================

create or replace function public.api_create_lost_report(
  p_school_code text,
  p_device_digest bytea,
  p_category text default null,
  p_description text default null,
  p_map_version_id uuid default null,
  p_pin_x double precision default null,
  p_pin_y double precision default null,
  p_lost_on date default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_cat public.item_category;
  v_desc text;
  v_map uuid;
  v_today date;
  v_open int;
  v_next timestamptz;
  v_id uuid;
  v_expires timestamptz;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);
  if not private.feature_on(s, 'lost_reports') then
    perform private.fail('feature_disabled');
  end if;
  v_cat := private.student_category(p_category);
  v_desc := private.student_clean_text(p_description, 3, 200, 'description');
  v_map := private.student_check_pin(s.id, p_map_version_id, p_pin_x, p_pin_y);
  v_today := (now() at time zone s.timezone)::date;
  if p_lost_on is not null and (p_lost_on > v_today or p_lost_on < v_today - 60) then
    perform private.fail('invalid_input', 'lost_on');
  end if;

  -- Touching the device row locks it, which serializes concurrent creates from one browser for the cap.
  insert into public.devices (school_id, token_hash)
  values (s.id, p_device_digest)
  on conflict (school_id, token_hash) do update set last_seen_at = now();

  -- §12.4: at most 5 open reports per device; retry when the oldest open one expires.
  select count(*), min(r.expires_at) into v_open, v_next
    from public.lost_reports r
   where r.school_id = s.id and r.device_token_hash = p_device_digest and r.status = 'open';
  if v_open >= 5 then
    perform private.fail('rate_limited', greatest(1, ceil(extract(epoch from (v_next - now()))))::int::text);
  end if;

  v_expires := now() + make_interval(days => (private.district()).lost_report_ttl_days);
  insert into public.lost_reports (school_id, category, description, map_version_id, pin_x, pin_y, lost_on,
                                   device_token_hash, status, expires_at)
  values (s.id, v_cat, v_desc, v_map,
          case when v_map is not null then p_pin_x end, case when v_map is not null then p_pin_y end,
          p_lost_on, p_device_digest, 'open', v_expires)
  returning id into v_id;

  perform private.enqueue('match_report', jsonb_build_object('reportId', v_id), s.id, 'match_report:' || v_id::text);
  perform private.student_bump_stats(s.id, s.timezone, p_lost_reports => 1);
  perform private.audit(s.id, 'device', null, null, 'report.create', 'lost_reports', v_id::text,
                        '{}'::jsonb, jsonb_build_object('status', 'open'), jsonb_build_object('category', v_cat));

  return jsonb_build_object('reportId', v_id, 'status', 'open', 'expiresAt', v_expires);
end $$;
alter function public.api_create_lost_report(text, bytea, text, text, uuid, double precision, double precision, date) owner to recover_api_owner;
revoke all on function public.api_create_lost_report(text, bytea, text, text, uuid, double precision, double precision, date) from public;
grant execute on function public.api_create_lost_report(text, bytea, text, text, uuid, double precision, double precision, date) to recover_web;

-- This device's open reports (F-78: school AND digest). Matches join through public_items, so matches to
-- items that left the feed vanish (§12.2); at most 10 by score, each with its lowest-position thumbnail.
-- matchCount counts the matches listed here.
create or replace function public.api_my_lost_reports(p_school_code text, p_device_digest bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  v jsonb;
begin
  perform private.student_check_digest(p_device_digest);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id,
           'category', r.category,
           'description', r.description,
           'status', r.status,
           'matchCount', m.cnt,
           'lastMatchedAt', r.last_matched_at,
           'lastViewedAt', r.last_viewed_at,
           'expiresAt', r.expires_at,
           'rowVersion', r.row_version,
           'matches', m.items)
         order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v
    from public.lost_reports r
    cross join lateral (
      select count(*)::int as cnt,
             coalesce(jsonb_agg(jsonb_build_object(
               'itemId', t.id,
               'publicId', t.public_id,
               'category', t.category,
               'description', t.description,
               'score', t.score,
               'custody', t.custody,
               'locationId', t.location_id,
               'thumbPath', (select ph.thumb_path from public.public_item_photos ph
                              where ph.item_id = t.id and ph.school_id = t.school_id
                              order by ph.position limit 1))
             order by t.score desc, t.matched_at desc, t.id), '[]'::jsonb) as items
        from (select pi.id, pi.school_id, pi.public_id, pi.category, pi.description, pi.custody, pi.location_id,
                     mm.score, mm.matched_at
                from public.lost_report_matches mm
                join public.public_items pi on pi.id = mm.item_id and pi.school_id = mm.school_id
               where mm.lost_report_id = r.id and mm.school_id = r.school_id
               order by mm.score desc, mm.matched_at desc, pi.id
               limit 10) t
    ) m
   where r.school_id = s.id and r.device_token_hash = p_device_digest and r.status = 'open';
  return jsonb_build_object('reports', v);
end $$;
alter function public.api_my_lost_reports(text, bytea) owner to recover_api_owner;
revoke all on function public.api_my_lost_reports(text, bytea) from public;
grant execute on function public.api_my_lost_reports(text, bytea) to recover_web;

-- Appendix C report_close (device path): digest and row_version must match and the report must be open.
create or replace function public.api_close_lost_report(
  p_school_code text, p_device_digest bytea, p_report_id uuid, p_row_version bigint, p_outcome text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_id uuid;
  v_status text;
  v_rv bigint;
  v_new text;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);
  if p_outcome is null or p_outcome not in ('found', 'dismiss') then
    perform private.fail('invalid_input', 'outcome');
  end if;
  if p_row_version is null then
    perform private.fail('invalid_input', 'row_version');
  end if;

  select r.id, r.status, r.row_version into v_id, v_status, v_rv
    from public.lost_reports r
   where r.id = p_report_id and r.school_id = s.id and r.device_token_hash = p_device_digest
   for update;
  if v_id is null then
    perform private.fail('not_found');
  end if;
  if v_status <> 'open' or v_rv <> p_row_version then
    perform private.fail('state_changed');
  end if;

  v_new := case p_outcome when 'found' then 'closed_found' else 'closed_by_user' end;
  update public.lost_reports r
     set status = v_new, terminal_at = now()
   where r.id = v_id and r.school_id = s.id;

  if v_new = 'closed_found' then
    perform private.student_bump_stats(s.id, s.timezone, p_reports_closed_found => 1);
  end if;
  perform private.audit(s.id, 'device', null, null, 'report.close', 'lost_reports', v_id::text,
                        jsonb_build_object('status', 'open'), jsonb_build_object('status', v_new),
                        jsonb_build_object('outcome', p_outcome));
  return jsonb_build_object('reportId', v_id, 'status', v_new);
end $$;
alter function public.api_close_lost_report(text, bytea, uuid, bigint, text) owner to recover_api_owner;
revoke all on function public.api_close_lost_report(text, bytea, uuid, bigint, text) from public;
grant execute on function public.api_close_lost_report(text, bytea, uuid, bigint, text) to recover_web;

-- Appendix C report_seen: seen_at on the listed (visible) matches not seen before, matches_viewed funnel
-- counter (F-63). last_viewed_at is written only when there is something new to acknowledge, because every
-- lost_reports update bumps row_version and the device's close call carries the row_version it listed.
create or replace function public.api_mark_report_seen(
  p_school_code text, p_device_digest bytea, p_report_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_id uuid;
  v_status text;
  v_last_matched timestamptz;
  v_last_viewed timestamptz;
  v_seen int;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_device_digest);

  select r.id, r.status, r.last_matched_at, r.last_viewed_at
    into v_id, v_status, v_last_matched, v_last_viewed
    from public.lost_reports r
   where r.id = p_report_id and r.school_id = s.id and r.device_token_hash = p_device_digest
   for update;
  if v_id is null then
    perform private.fail('not_found');
  end if;
  if v_status <> 'open' then
    perform private.fail('state_changed');
  end if;

  with seen as (
    update public.lost_report_matches m
       set seen_at = now()
     where m.lost_report_id = v_id and m.school_id = s.id and m.seen_at is null
       and exists (select 1 from public.public_items pi where pi.id = m.item_id and pi.school_id = m.school_id)
    returning 1
  )
  select count(*) into v_seen from seen;

  if v_seen > 0 or v_last_viewed is null or v_last_matched > v_last_viewed then
    update public.lost_reports r set last_viewed_at = now() where r.id = v_id and r.school_id = s.id;
  end if;
  if v_seen > 0 then
    perform private.student_bump_stats(s.id, s.timezone, p_matches_viewed => v_seen);
  end if;
  return jsonb_build_object('ok', true);
end $$;
alter function public.api_mark_report_seen(text, bytea, uuid) owner to recover_api_owner;
revoke all on function public.api_mark_report_seen(text, bytea, uuid) from public;
grant execute on function public.api_mark_report_seen(text, bytea, uuid) to recover_web;

-- =====================================================================================================
-- Counters, telemetry, health
-- =====================================================================================================

-- §5.1 step 2: the high-value redirect is a count only; no row, no device, no photo.
create or replace function public.api_record_high_value_redirect(p_school_code text, p_category text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  if p_category is null or p_category not in ('phone', 'wallet', 'keys', 'id_card', 'medication') then
    perform private.fail('invalid_input', 'category');
  end if;
  perform private.student_bump_stats(s.id, s.timezone, p_high_value_redirects => 1);
  return jsonb_build_object('ok', true);
end $$;
alter function public.api_record_high_value_redirect(text, text) owner to recover_api_owner;
revoke all on function public.api_record_high_value_redirect(text, text) from public;
grant execute on function public.api_record_high_value_redirect(text, text) to recover_web;

-- G-29: client error signatures (route plus error class, no free text) counted per UTC day.
create or replace function public.api_record_error(p_signature text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  set local lock_timeout = '3s';
  if p_signature is null or p_signature !~ '^[A-Za-z0-9_:/.\[\]-]{1,120}$' then
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

create or replace function public.api_get_staff_domains() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object('domains',
    coalesce((select to_jsonb(d.staff_email_domains) from public.district_settings d where d.id = 1), '[]'::jsonb));
end $$;
alter function public.api_get_staff_domains() owner to recover_api_owner;
revoke all on function public.api_get_staff_domains() from public;
grant execute on function public.api_get_staff_domains() to recover_web;

-- §15 health model inputs for /api/internal/ready. Ages are whole seconds.
--   oldestJobS: oldest queued job that is due (future run_after is scheduled work, not backlog), 0 if none.
--   deadJobs: jobs that went dead in the last 24 h.
--   calendarHorizonD: minimum over active schools of calendar days covered beyond the local today.
--   deletionUnverifiedMaxAgeS: oldest unverified deletion ledger measured from when it became due
--     (deferred never-arrived deletions only count once their job's run_after passes), 0 if none.
--   workerHeartbeatAgeS: age of the newest worker heartbeat, NULL if no worker has ever reported.
create or replace function public.api_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_oldest int;
  v_dead int;
  v_horizon int;
  v_deletion int;
  v_heartbeat int;
begin
  select floor(extract(epoch from (now() - min(j.run_after))))::int into v_oldest
    from public.jobs j
   where j.status = 'queued' and j.run_after <= now();

  select count(*)::int into v_dead
    from public.jobs j
   where j.status = 'dead' and coalesce(j.finished_at, j.created_at) > now() - interval '24 hours';

  select min(h.days) into v_horizon
    from (select greatest(coalesce(max(c.day) - (now() at time zone sc.timezone)::date, 0), 0) as days
            from public.schools sc
            left join public.school_calendar_days c on c.school_id = sc.id
           where sc.active
           group by sc.id, sc.timezone) h;

  select floor(extract(epoch from (now() - min(x.due))))::int into v_deletion
    from (select greatest(l.requested_at, coalesce(max(j.run_after), l.requested_at)) as due
            from public.media_deletion_ledger l
            left join public.jobs j on j.kind = 'delete_media' and j.payload->>'ledgerId' = l.id::text
           where l.verified_at is null
           group by l.id, l.requested_at) x
   where x.due <= now();

  select floor(extract(epoch from (now() - max(w.seen_at))))::int into v_heartbeat
    from public.worker_heartbeats w;

  return jsonb_build_object(
    'db', true,
    'oldestJobS', coalesce(v_oldest, 0),
    'deadJobs', v_dead,
    'calendarHorizonD', v_horizon,
    'deletionUnverifiedMaxAgeS', coalesce(v_deletion, 0),
    'workerHeartbeatAgeS', v_heartbeat);
end $$;
alter function public.api_health() owner to recover_api_owner;
revoke all on function public.api_health() from public;
grant execute on function public.api_health() to recover_web;

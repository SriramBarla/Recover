-- 0007 operational tables: audit, outbox, deletion ledger, idempotency, rate limits, telemetry,
-- media tickets (G-04), synonyms (G-22), worker heartbeat.
set lock_timeout = '5s';
set statement_timeout = '60s';

create table public.audit_log (
  id            bigint generated always as identity primary key,
  school_id     uuid,
  actor_kind    text not null check (actor_kind in ('staff', 'system', 'device')),
  actor_id      text,        -- staff membership id or system name; NULL for device-origin actions
  request_id    uuid,
  action        text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_table  text not null,
  target_id     text not null,
  state_before  jsonb not null default '{}'::jsonb,
  state_after   jsonb not null default '{}'::jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
-- Payloads are allowlisted per action; free text, pins, digests, paths, emails, bodies are forbidden (F-74).

create table public.jobs (
  id               bigint generated always as identity primary key,
  school_id        uuid references public.schools(id),
  kind             text not null check (kind ~ '^[a-z_]{3,40}$'),
  payload          jsonb not null default '{}'::jsonb,  -- opaque ids and codes only
  payload_version  smallint not null default 1,
  dedupe_key       text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  priority         smallint not null default 100,
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  attempts         int not null default 0 check (attempts >= 0),
  max_attempts     int not null default 5 check (max_attempts >= 1),
  run_after        timestamptz not null default now(),
  locked_at        timestamptz,
  locked_until     timestamptz,
  locked_by        text,
  last_error_code  text check (last_error_code is null or char_length(last_error_code) <= 60),
  request_id       uuid,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  disposed_at      timestamptz  -- operator disposition of a dead job (retention clock)
);
create unique index jobs_active_dedupe on public.jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create table public.media_deletion_ledger (
  id               bigint generated always as identity primary key,
  school_id        uuid not null references public.schools(id),
  item_id          uuid not null,
  reason           text not null check (reason ~ '^[a-z_]{2,40}$'),
  requested_at     timestamptz not null default now(),
  verified_at      timestamptz,
  last_error_code  text,
  unique (id, item_id, school_id),
  foreign key (item_id, school_id) references public.items(id, school_id)
);

create table public.media_deletion_objects (
  ledger_id        bigint not null,
  school_id        uuid not null,
  item_id          uuid not null,
  item_photo_id    uuid not null,
  storage_path     text,  -- NULLed by purge_deletion_evidence 90 d after verification
  object_kind      text not null check (object_kind in ('incoming', 'original', 'review', 'thumb', 'medium')),
  deleted_at       timestamptz,
  verified_at      timestamptz,
  attempts         int not null default 0 check (attempts >= 0),
  last_error_code  text,
  primary key (ledger_id, item_photo_id, object_kind),
  foreign key (ledger_id, item_id, school_id) references public.media_deletion_ledger(id, item_id, school_id) on delete cascade,
  foreign key (item_photo_id, item_id, school_id) references public.item_photos(id, item_id, school_id)
);

create table public.idempotency_keys (
  tenant_scope    text not null check (tenant_scope ~ '^(school:[0-9a-f-]{36}|district)$'),
  principal_kind  text not null check (principal_kind in ('device', 'staff', 'system', 'district')),
  operation       text not null check (operation ~ '^[a-z_.]{3,60}$'),
  principal_hmac  bytea not null,
  key_hash        bytea not null,
  request_hash    bytea not null,
  response_code   int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  primary key (tenant_scope, principal_kind, operation, principal_hmac, key_hash)
);

create table public.rate_counters (
  tenant_scope  text not null,
  action        text not null,
  subject_kind  text not null check (subject_kind in ('device', 'ip', 'school', 'district')),
  subject_hmac  bytea not null,
  window_start  timestamptz not null,
  count         int not null default 0 check (count >= 0),
  primary key (tenant_scope, action, subject_kind, subject_hmac, window_start)
);

create table public.search_events (
  id                bigint generated always as identity primary key,
  school_id         uuid not null references public.schools(id),
  query_hmac        bytea not null,
  redacted_query    text check (redacted_query is null or char_length(redacted_query) <= 120),
  result_count      int not null check (result_count >= 0),
  clicked_position  int,
  created_at        timestamptz not null default now(),
  purge_after       timestamptz not null
);

create table public.health_checks (
  checked_at  timestamptz primary key default now(),
  ok          boolean not null,
  latency_ms  int,
  detail      jsonb not null default '{}'::jsonb
);

create table public.error_rollup (
  day                date not null,
  signature          text not null check (char_length(signature) <= 120),
  count              int not null default 0,
  sample_request_id  uuid,
  primary key (day, signature)
);

create table public.daily_school_stats (
  school_id             uuid not null references public.schools(id),
  day                   date not null,
  posted                int not null default 0,
  approved              int not null default 0,
  rejected              int not null default 0,
  received              int not null default 0,
  claimed               int not null default 0,
  expired               int not null default 0,
  searches              int not null default 0,
  zero_result_searches  int not null default 0,
  lost_reports          int not null default 0,
  matches_surfaced      int not null default 0,
  matches_viewed        int not null default 0,
  reports_closed_found  int not null default 0,
  received_cohort_7d    int not null default 0,
  received_cohort_30d   int not null default 0,
  queue_age_p95_hours   double precision,
  screening_images      int not null default 0,
  high_value_redirects  int not null default 0,
  primary key (school_id, day)
);

-- G-04: single-use, 30-second media capabilities issued by the API family, redeemed by the worker.
create table public.media_tickets (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null references public.schools(id),
  operation        text not null check (operation in ('media.read', 'map.upload', 'map.read', 'map.activate')),
  item_id          uuid,
  item_photo_id    uuid,
  map_version_id   uuid,
  staff_member_id  uuid not null references public.staff_members(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz,
  foreign key (item_photo_id, item_id, school_id) references public.item_photos(id, item_id, school_id) on delete cascade,
  foreign key (map_version_id, school_id) references public.map_versions(id, school_id) on delete cascade,
  check ((operation = 'media.read') = (item_photo_id is not null and item_id is not null)),
  check ((operation in ('map.upload', 'map.read', 'map.activate')) = (map_version_id is not null))
);

-- G-22: district vocabulary loaded from packages/shared/src/synonyms.json at deploy.
create table public.synonyms (
  term        text primary key check (term = private.search_norm(term)),
  expansions  text[] not null
);

create table public.worker_heartbeats (
  worker_id  text primary key check (char_length(worker_id) <= 80),
  seen_at    timestamptz not null default now()
);

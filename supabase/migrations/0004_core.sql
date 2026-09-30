-- 0004 core tenant tables (§4, §7.1) with the BUILD-CONTRACT section 3 resolutions.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Text normalization used by generated search columns and by queries (G-22: unaccent both sides).
create function private.f_unaccent(p text) returns text
language sql immutable parallel safe strict
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, p) $$;

create function private.search_norm(p text) returns text
language sql immutable parallel safe
as $$ select lower(private.f_unaccent(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))) $$;

create table public.schools (
  id                            uuid primary key default gen_random_uuid(),
  code                          text not null unique check (code ~ '^[A-Z]{2,6}$'),
  name                          text not null check (char_length(name) between 2 and 120),
  timezone                      text not null default 'America/New_York',
  student_posting_enabled       boolean not null default false,
  lost_reports_enabled          boolean not null default false,
  cross_school_search_enabled   boolean not null default false,
  retention_days                int not null default 30 check (retention_days between 1 and 365),
  never_arrived_school_days     int not null default 1 check (never_arrived_school_days between 1 and 10),
  late_arrival_grace_days       int not null default 7 check (late_arrival_grace_days between 0 and 30), -- G-01
  terminal_text_retention_days  int not null default 30 check (terminal_text_retention_days between 0 and 30),
  enabled_categories            public.item_category[] not null
                                  default '{bag,clothing,bottle,book,electronics_low,jewelry,sports,other}',
  active                        boolean not null default true,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create table public.district_settings (
  id                                  int primary key default 1 check (id = 1),
  retention_days_floor                int not null default 14 check (retention_days_floor >= 1),
  retention_days_ceiling              int not null default 60 check (retention_days_ceiling >= retention_days_floor),
  staff_email_domains                 text[] not null default '{}',
  lost_report_ttl_days                int not null default 60 check (lost_report_ttl_days between 1 and 180),
  student_posting_global_enabled      boolean not null default false,
  lost_reports_global_enabled         boolean not null default false,
  cross_school_search_global_enabled  boolean not null default false,
  screening_enabled                   boolean not null default true,
  screening_daily_ceiling             int not null default 500 check (screening_daily_ceiling >= 0),
  rejected_media_retention_days       int not null default 7 check (rejected_media_retention_days between 1 and 90),
  worker_mode                         text not null default 'normal' check (worker_mode in ('normal', 'quarantine')), -- G-06
  campus_cidrs                        text[] not null default '{}',  -- O-3; empty = everyone off-campus
  redacted_search_enabled             boolean not null default false, -- §11.5 opt-in
  updated_at                          timestamptz not null default now()
);

create table public.staff_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  google_sub     text unique,
  display_name   text check (display_name is null or char_length(display_name) <= 120),
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
create unique index staff_users_email_lower_uq on public.staff_users (lower(email));

create table public.staff_members (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.staff_users(id),
  school_id    uuid references public.schools(id),
  role         public.staff_role not null,
  status       text not null default 'invited' check (status in ('invited', 'active', 'deactivated')),
  invited_by   uuid references public.staff_members(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, school_id),
  check ((role = 'district_admin') = (school_id is null))
);
create unique index staff_members_one_district_role_per_user on public.staff_members (user_id) where school_id is null;

-- G-07: dimensions are known only after canonicalization; 'retired' replaces an activated version.
create table public.map_versions (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools(id),
  draft_storage_path   text,   -- map_drafts raw upload key
  draft_canonical_path text,   -- map_drafts canonical.jpg key
  public_storage_path  text,   -- maps key; set only by district activation
  width_px             int check (width_px is null or width_px > 0),
  height_px            int check (height_px is null or height_px > 0),
  approval_status      text not null default 'draft'
                         check (approval_status in ('draft', 'pending_district', 'approved', 'rejected', 'retired')),
  active               boolean not null default false,
  created_by           uuid references public.staff_members(id),
  submitted_at         timestamptz,
  approved_by          uuid references public.staff_members(id),
  approved_at          timestamptz,
  rejected_reason      text check (rejected_reason is null or char_length(rejected_reason) <= 200),
  retired_at           timestamptz,
  created_at           timestamptz not null default now(),
  unique (id, school_id),
  check (approval_status not in ('pending_district', 'approved', 'retired') or (width_px is not null and height_px is not null)),
  check (approval_status <> 'approved' or (public_storage_path is not null and approved_by is not null and approved_at is not null)),
  check (public_storage_path is null or approval_status in ('approved', 'retired')),
  check (not active or approval_status = 'approved'),
  check (approval_status <> 'retired' or retired_at is not null)
);
create unique index map_versions_one_active on public.map_versions (school_id) where active;

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id),
  code        text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  name        text not null check (char_length(name) between 2 and 60),
  hours       text check (hours is null or char_length(hours) <= 120),
  item_seq    bigint not null default 0 check (item_seq >= 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (school_id, code),
  unique (id, school_id)
);

create table public.location_map_pins (
  school_id      uuid not null references public.schools(id),
  location_id    uuid not null,
  map_version_id uuid not null,
  pin_x          double precision not null check (pin_x between 0 and 1),
  pin_y          double precision not null check (pin_y between 0 and 1),
  primary key (location_id, map_version_id),
  foreign key (location_id, school_id) references public.locations(id, school_id),
  foreign key (map_version_id, school_id) references public.map_versions(id, school_id)
);

-- Public location labels come only from here (F-57, D-15). Frozen once the version leaves draft (G-07).
create table public.map_zones (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools(id),
  map_version_id uuid not null,
  name           text not null check (char_length(name) between 2 and 40),
  cx             double precision not null check (cx between 0 and 1),
  cy             double precision not null check (cy between 0 and 1),
  radius         double precision not null check (radius > 0 and radius <= 0.5),
  active         boolean not null default true,
  unique (id, school_id),
  unique (id, map_version_id, school_id),
  unique (map_version_id, name),
  foreign key (map_version_id, school_id) references public.map_versions(id, school_id)
);

create table public.school_calendar_days (
  school_id  uuid not null references public.schools(id),
  day        date not null,
  is_open    boolean not null,
  open_at    time,
  close_at   time,
  source     text not null default 'district' check (char_length(source) <= 40),
  note       text check (note is null or char_length(note) <= 120),
  primary key (school_id, day),
  check ((is_open and open_at is not null and close_at is not null and open_at < close_at)
         or (not is_open and open_at is null and close_at is null))
);

create table public.devices (
  school_id      uuid not null references public.schools(id),
  token_hash     bytea not null check (octet_length(token_hash) = 33),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  blocked_until  timestamptz,
  block_reason   text check (block_reason is null or block_reason in ('auto_rejections', 'staff', 'abuse', 'spam', 'other')),
  blocked_by     uuid references public.staff_members(id),
  primary key (school_id, token_hash)
);

-- G-12: minimal security record so reputation keeps its 30-day window after content is anonymized at 7 days.
create table public.device_rejections (
  id                 bigint generated always as identity primary key,
  school_id          uuid not null references public.schools(id),
  device_token_hash  bytea not null check (octet_length(device_token_hash) = 33),
  rejected_at        timestamptz not null default now()
);

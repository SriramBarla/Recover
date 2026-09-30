-- 0005 items, photo generations, screening runs (§6.1, §7.1) with G-02, G-03, G-14, G-26, G-37, G-38.
set lock_timeout = '5s';
set statement_timeout = '60s';

create table public.items (
  id                      uuid primary key default gen_random_uuid(),
  school_id               uuid not null references public.schools(id),
  public_id               text unique,  -- NULL only while draft (F-17)
  category                public.item_category not null,
  description             text check (description is null or char_length(description) between 2 and 120),
  location_note_private   text check (location_note_private is null or char_length(location_note_private) <= 80),
  zone_id                 uuid,
  map_version_id          uuid,
  pin_x                   double precision check (pin_x between 0 and 1),
  pin_y                   double precision check (pin_y between 0 and 1),
  dropoff_location_id     uuid not null,
  current_location_id     uuid,
  photo_count             smallint not null default 1 check (photo_count between 1 and 3), -- G-37
  review_status           public.review_status not null default 'draft',
  publication_status      public.publication_status not null default 'hidden',
  custody                 public.custody_status not null default 'with_finder',
  posted_by_kind          text not null check (posted_by_kind in ('student', 'staff', 'backfill')),
  posted_by_staff_id      uuid references public.staff_members(id),
  device_token_hash       bytea check (device_token_hash is null or octet_length(device_token_hash) = 33),
  device_link_cleared_at  timestamptz,  -- G-03
  found_at                timestamptz not null default now(),
  received_at             timestamptz,
  claimed_at              timestamptz,
  expires_at              timestamptz,
  disposition_due_at      timestamptz,
  arrival_deadline_at     timestamptz,
  disposed_at             timestamptz,
  terminal_at             timestamptz,  -- G-14: custody became terminal
  withdrawn_at            timestamptz,  -- G-14: publication became withdrawn
  reviewed_by             uuid references public.staff_members(id),
  reviewed_at             timestamptz,
  reject_reason           text check (reject_reason in ('inappropriate', 'not_an_item', 'duplicate', 'pii_visible', 'spam', 'other')),
  screening_status        public.screening_status not null default 'unscreened',
  screening_flags         jsonb not null default '{}'::jsonb,  -- derived signals only (F-53)
  search_tsv              tsvector generated always as (
                            setweight(to_tsvector('simple'::regconfig, private.f_unaccent(coalesce(description, ''))), 'A') ||
                            setweight(to_tsvector('english'::regconfig, private.f_unaccent(coalesce(description, ''))), 'B')
                          ) stored,
  src                     text check (src is null or src ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  content_anonymized_at   timestamptz,
  text_cleared_at         timestamptz,
  deleted_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  row_version             bigint not null default 0,

  unique (id, school_id),
  foreign key (map_version_id, school_id) references public.map_versions(id, school_id),
  foreign key (dropoff_location_id, school_id) references public.locations(id, school_id),
  foreign key (current_location_id, school_id) references public.locations(id, school_id),
  foreign key (zone_id, map_version_id, school_id) references public.map_zones(id, map_version_id, school_id),
  -- device_token_hash is intentionally not a FK: devices are short-lived security state (F-52).

  check ((pin_x is null) = (pin_y is null)),
  check (pin_x is null or map_version_id is not null),
  check (zone_id is null or map_version_id is not null),
  check (review_status = 'draft' or public_id is not null),
  check (description is not null or review_status = 'rejected' or text_cleared_at is not null),
  check (publication_status <> 'published' or description is not null),
  check (posted_by_kind <> 'student' or device_token_hash is not null or device_link_cleared_at is not null), -- G-03
  check (device_link_cleared_at is null or device_token_hash is null),
  check (posted_by_kind = 'student' or posted_by_staff_id is not null),
  check (category not in ('phone', 'wallet', 'keys', 'id_card', 'medication') or posted_by_kind <> 'student'),
  check (review_status <> 'rejected' or (reject_reason is not null and reviewed_at is not null and reviewed_by is not null)),
  check (review_status not in ('approved', 'rejected') or reviewed_at is not null),
  check (publication_status not in ('generating', 'published', 'withdrawn') or review_status = 'approved'),
  check (custody <> 'at_location' or (received_at is not null and current_location_id is not null)),
  check (custody <> 'claimed' or claimed_at is not null),
  check (disposed_at is null or custody in ('expired_donated', 'expired_disposed')),
  check (disposition_due_at is null or (expires_at is not null and custody in ('at_location', 'expired_donated', 'expired_disposed'))),
  -- G-02: terminal custody never coexists with a live or in-flight publication.
  check (custody not in ('claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived')
         or publication_status in ('hidden', 'withdrawn')),
  check ((custody in ('claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived')) = (terminal_at is not null)),
  check ((publication_status = 'withdrawn') = (withdrawn_at is not null)),
  check (deleted_at is null or publication_status in ('hidden', 'withdrawn')),
  check (content_anonymized_at is null or
         (review_status = 'rejected' and description is null and location_note_private is null and
          pin_x is null and pin_y is null and zone_id is null and src is null)),
  check (text_cleared_at is null or
         ((terminal_at is not null or deleted_at is not null) and description is null and
          location_note_private is null and pin_x is null and pin_y is null and zone_id is null and src is null))
);

-- One immutable generation per row (F-71). Keys are bucket-relative (BUILD-CONTRACT section 8).
create table public.item_photos (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools(id),
  item_id              uuid not null,
  position             smallint not null check (position between 0 and 2),
  generation           int not null check (generation >= 1),
  is_current           boolean not null default false,
  incoming_path        text,   -- raw hostile upload (incoming bucket)
  original_path        text,   -- canonical JPEG (originals bucket)
  review_path          text,   -- private review rendition (originals bucket; G-28)
  thumb_path           text,   -- variants bucket, includes public_object_token
  medium_path          text,
  public_object_token  bytea check (public_object_token is null or octet_length(public_object_token) = 16),
  raw_bytes            int check (raw_bytes is null or (raw_bytes > 0 and raw_bytes <= 1048576)), -- G-38
  bytes                int check (bytes is null or bytes > 0),
  width                int check (width is null or width > 0),
  height               int check (height is null or height > 0),
  content_fingerprint  bytea,
  status               text not null default 'uploaded'
                         check (status in ('uploaded', 'canonicalizing', 'canonical_ready', 'public_ready', 'failed', 'deleted')),
  failure_code         text check (failure_code is null or failure_code ~ '^[a-z_]{2,40}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (item_id, position, generation),
  unique (id, item_id, school_id),
  foreign key (item_id, school_id) references public.items(id, school_id) on delete cascade,
  check (status not in ('canonical_ready', 'public_ready') or (original_path is not null and review_path is not null)),
  check (status <> 'public_ready' or (thumb_path is not null and medium_path is not null and public_object_token is not null)),
  check (status <> 'deleted' or
         (incoming_path is null and original_path is null and review_path is null and thumb_path is null and medium_path is null))
);
create unique index item_photos_one_current_per_slot on public.item_photos (item_id, position) where is_current;

create table public.screening_runs (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id),
  item_id         uuid not null,
  item_photo_id   uuid not null,  -- G-26
  provider        text not null check (char_length(provider) <= 40),
  model           text not null check (char_length(model) <= 60),
  policy_version  text not null check (char_length(policy_version) <= 20),
  status          text not null check (status in ('ok', 'partial', 'error')),
  signals         jsonb not null default '{}'::jsonb,  -- booleans/counts/scores only (F-53)
  error_code      text,
  created_at      timestamptz not null default now(),
  unique (item_photo_id, policy_version),  -- G-26
  foreign key (item_id, school_id) references public.items(id, school_id) on delete cascade,
  foreign key (item_photo_id, item_id, school_id) references public.item_photos(id, item_id, school_id) on delete cascade
);

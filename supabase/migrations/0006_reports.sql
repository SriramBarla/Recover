-- 0006 lost reports and matches (§6.2, §12) with G-43 (closed_by_staff).
set lock_timeout = '5s';
set statement_timeout = '60s';

create table public.lost_reports (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null references public.schools(id),
  category            public.item_category,
  description         text check (description is null or char_length(description) between 3 and 200),
  map_version_id      uuid,
  pin_x               double precision check (pin_x between 0 and 1),
  pin_y               double precision check (pin_y between 0 and 1),
  lost_on             date,
  device_token_hash   bytea check (device_token_hash is null or octet_length(device_token_hash) = 33),
  status              text not null default 'open'
                        check (status in ('open', 'closed_found', 'closed_by_user', 'closed_by_staff', 'expired')),
  match_count         int not null default 0 check (match_count >= 0),
  last_matched_at     timestamptz,
  last_viewed_at      timestamptz,
  search_tsv          tsvector generated always as (
                        setweight(to_tsvector('simple'::regconfig, private.f_unaccent(coalesce(description, ''))), 'A') ||
                        setweight(to_tsvector('english'::regconfig, private.f_unaccent(coalesce(description, ''))), 'B')
                      ) stored,
  expires_at          timestamptz not null,
  terminal_at         timestamptz,
  content_cleared_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  row_version         bigint not null default 0,
  unique (id, school_id),
  foreign key (map_version_id, school_id) references public.map_versions(id, school_id),
  check ((pin_x is null) = (pin_y is null)),
  check (pin_x is null or map_version_id is not null),
  check (status <> 'open' or (description is not null and device_token_hash is not null)),
  check ((status = 'open') = (terminal_at is null)),
  check (content_cleared_at is null or
         (status <> 'open' and description is null and pin_x is null and pin_y is null and device_token_hash is null))
);

create table public.lost_report_matches (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id),
  lost_report_id  uuid not null,
  item_id         uuid not null,
  score           double precision not null check (score >= 0 and score <= 1),
  features        jsonb not null default '{}'::jsonb,  -- coarse contributions only; no text
  scorer_version  text not null check (char_length(scorer_version) <= 20),
  matched_at      timestamptz not null default now(),
  seen_at         timestamptz,
  unique (lost_report_id, item_id),
  foreign key (lost_report_id, school_id) references public.lost_reports(id, school_id) on delete cascade,
  foreign key (item_id, school_id) references public.items(id, school_id) on delete cascade
);

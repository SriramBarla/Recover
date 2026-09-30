-- 0003 enums for sets that only change with a migration (05 "Enum policy").
set lock_timeout = '5s';
set statement_timeout = '60s';

create type public.staff_role as enum ('reviewer', 'office', 'school_admin', 'district_admin');

create type public.item_category as enum (
  'bag', 'clothing', 'bottle', 'book', 'electronics_low', 'jewelry', 'sports', 'other',
  'phone', 'wallet', 'keys', 'id_card', 'medication'
);

create type public.review_status as enum ('draft', 'pending', 'approved', 'rejected');
create type public.publication_status as enum ('hidden', 'generating', 'published', 'withdrawn');
create type public.custody_status as enum (
  'with_finder', 'at_location', 'claimed',
  'expired_donated', 'expired_disposed', 'expired_never_arrived'
);
create type public.screening_status as enum ('unscreened', 'clean', 'flagged', 'error');

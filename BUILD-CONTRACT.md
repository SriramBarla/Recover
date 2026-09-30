# Recover build contract (Sep 30 build)

This file is the coordination contract for everyone building Recover in this repository, whether human or agent. The specification is the library in `files (16)/` (start at `00-Index.md`). Its known gaps are in `files (16)/ANALYSIS.md`, and the resolutions below override the library where they differ. If this file and the library disagree, this file wins. Record the disagreement in your final report.

Owner decisions of 2026-09-30:
- All packages below are approved.
- "1 school day" means the next school day, and late check-in of expired items is allowed.
- Unreviewed or rejected items may be claimed or disposed.
- Build everything by Sep 30.

## 0. Ground rules

- **Language and modules.** TypeScript strict throughout. ESM everywhere. Import local TS files with the `.ts` extension, because Node 22.18 strips types natively and `node --test` imports `.ts` directly. Use `import type` for types (`verbatimModuleSyntax`).
- **Erasable syntax only.** No enums, no namespaces, no constructor parameter properties.
- **Dependencies.** No new npm packages. Approved and installed: next 16.3.7, react 19.3, react-dom 19.3, next-auth 5.0.0-beta.32, postgres 3.4.9, jose 6.2.12 (worker only), sharp 0.35.5 (worker only), typescript 6.0.3, @types/node 22, @types/react 19. Use the Node standard library for everything else. No zod, no UI kits, no CSS frameworks.
- **Tests.** Use `node --test` with `.test.mjs` files that import `.ts` sources by relative path. SQL tests are plain `.sql` files that `RAISE` on failure.
- **Comments.** ASCII punctuation in code comments. Cite the spec as `§9.3` or `F-73` and gaps as `G-01`.
- **Security invariants.** These are from `files (16)/CLAUDE.md` and apply everywhere:
  - The web app never holds the S3 key.
  - Never `SELECT *` into a response.
  - Student text is public only in the item description.
  - Nothing a student submits is public until it is approved and `published`.
  - Composite tenant FKs.
  - Side effects are outbox rows in the same transaction.
  - Jobs are idempotent.
  - No free text, pins, digests, paths, or bodies in logs, audit, or job payloads.

## 1. Local stack

**Supabase.** Project id `recover`. API, Kong, and storage run on `http://127.0.0.1:55421`. The database is at `postgresql://postgres:postgres@127.0.0.1:55422/postgres`. Only the db, storage, and Kong services run (plus PostgREST, which has no grants).

**App logins.** `supabase/seed.sql` sets local-only passwords:
- `recover_web`: `postgresql://recover_web:recover_web_dev@127.0.0.1:55422/postgres`
- `recover_worker`: `postgresql://recover_worker:recover_worker_dev@127.0.0.1:55422/postgres`

**Storage.** The S3 endpoint is `http://127.0.0.1:55421/storage/v1/s3`, region `local`. Keys come from `supabase status -o env` (`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`). The public object base is `http://127.0.0.1:55421/storage/v1/object/public`.

**Apps.** Web on `http://localhost:3000`, worker on `http://localhost:3001`. `npm run dev` (`scripts/dev.mjs`) starts web, worker, and a dev scheduler that POSTs the worker drain every 10 s. The dev scheduler is the local stand-in for `pg_cron` calling the drain through the `http` extension, which remains the production path.

**Reset.** `supabase db reset` applies `supabase/migrations/*.sql` in filename order, then `supabase/seed.sql`.

## 2. File ownership (do not edit files you do not own; report needed changes instead)

| Owner | Files |
|---|---|
| lead (Claude main) | `BUILD-CONTRACT.md`; `README.md`; root `package.json`, `tsconfig.base.json`, `.gitignore`; `supabase/config.toml`; `supabase/migrations/0001`-`0099`; `supabase/seed.sql`; `packages/shared/src/{db,errors,dto,crypto,assertion}.ts`; `apps/web/app/layout.tsx`; `apps/web/app/globals.css`; `apps/web/proxy.ts`; `apps/web/lib/{db,env,worker}.ts`; `scripts/dev.mjs`; `scripts/dev-env.mjs`; `scripts/sql-tests.mjs` |
| A-shared | `packages/shared/src/{sigv4,unicode,rate,log,retention,audit,matcher,env}.ts`; `packages/shared/src/synonyms.json`; `tests/unit/shared-*.test.mjs`; `tests/vectors/**`; `scripts/gen-vectors.mjs` (also writes the assertion vector from `assertion.ts`) |
| A-worker | `apps/worker/**`; `tests/unit/worker-*.test.mjs`; `tests/fuzz/**` |
| A-student | `apps/web/app/s/**`; `apps/web/app/api/s/**`; `apps/web/app/api/search-all/**`; `apps/web/app/api/client-error/**`; `apps/web/app/offline/**`; `apps/web/app/page.tsx`; `apps/web/lib/{device,guard,idempotency,ratelimit,cache,storage-url,http}.ts`; `apps/web/components/student/**`; `apps/web/public/**` |
| A-staff | `apps/web/app/staff/**`; `apps/web/app/district/**`; `apps/web/app/api/staff/**`; `apps/web/app/api/district/**`; `apps/web/app/api/auth/**`; `apps/web/app/api/internal/**`; `apps/web/auth.ts`; `apps/web/lib/{staff,session,ops}.ts`; `apps/web/components/staff/**` |
| A-sql-student | `supabase/migrations/0200_api_student.sql`; `supabase/tests/api_student.sql` |
| A-sql-staff | `supabase/migrations/0300_api_staff.sql`; `supabase/tests/api_staff.sql` (item, custody, review, device, ticket and lost-report functions of 6.2 plus bind/resolve) |
| A-sql-admin | `supabase/migrations/0305_api_staff_admin.sql`; `supabase/tests/api_staff_admin.sql` (roster, locations, pins, map versions, drafts, zones, submit, config, calendar, stats, audit of 6.2) |
| A-sql-district | `supabase/migrations/0310_api_district.sql`; `supabase/tests/api_district.sql` (every function in 6.3) |
| A-ops | `RUNBOOK.md`; `scripts/{switch,rotate-db-password,rotate-assertion-key,restore-quarantine,jobs,calendar-horizon,audit-privacy-sample,reconcile-orphans,qr-posters,load-synonyms}.mjs`; `tests/unit/ops-*.test.mjs` |
| A-e2e | `tests/e2e/**`; `playwright.config.mjs` |
| A-sql-system | `supabase/migrations/0400_system.sql`; `supabase/migrations/0450_cron.sql`; `supabase/tests/{system,privilege_diff,tenant_property,constraints}.sql` |

## 3. Decisions applied (resolving ANALYSIS.md gaps)

### Arrival deadlines and custody (G-01, G-02, G-36)
- **Arrival deadline (G-01).** `calendar_next_close(school, ts, n)` returns the close time of the n-th open school day strictly after the local date of `ts`. With the default n = 1, that is the end of the next school day.
- **Late check-in (G-01).** An item in `expired_never_arrived` can be received within `schools.late_arrival_grace_days` (default 7) of `withdrawn_at`.
- **Deferred deletion (G-01).** Never-arrived expiry schedules media deletion with `run_after = now() + grace`. A late receive cancels that deletion and returns the item to `at_location`. If the item was published and its variants are intact, it goes back to `published`.
- **Terminal custody (G-02).** Terminal custody requires `publication_status in ('hidden','withdrawn')`.
- **Pending and rejected items (G-02).** These may be received, claimed, disposed, and expired. Their publication stays `hidden`, and the staff queue excludes terminal custody.
- **Never-arrived index (G-36).** Keyed on `arrival_deadline_at`. It covers every review state except draft.

### Device links and duplicates (G-03, G-11, G-12)
- **Clearing the device link (G-03).** Adds `items.device_link_cleared_at`. The CHECK is `posted_by_kind <> 'student' or device_token_hash is not null or device_link_cleared_at is not null`.
- **Duplicates (G-11).** Always a reviewer flag `duplicate`. There is never an auto-reject.
- **Device reputation (G-12).** Adds the table `device_rejections(school_id, device_token_hash, rejected_at)`, purged after 30 days. Reputation and auto-block read this table, never items.

### Media authorization and identity (G-04, G-05)
- **Media tickets (G-04).** Adds the table `media_tickets`. `api_staff_media_ticket` issues a ticket; `system_media_ticket_redeem` consumes it once. Each ticket expires 30 s after issue.
- **Identity functions (G-05).** `api_staff_bind_identity` and `api_staff_resolve_session` require an assertion with scope `district`, using operations `identity.bind` and `session.resolve`.

### Restore and maps (G-06, G-07)
- **Worker mode (G-06).** Adds `district_settings.worker_mode` (`normal` or `quarantine`). In quarantine, `system_lease_jobs` leases only `reconcile_generating` and `reconcile_orphan_uploads`.
- **Map dimensions (G-07).** `map_versions.width_px` and `height_px` are nullable until the map is canonical.
- **Map lifecycle (G-07).** Adds the approval state `retired`. Zones are frozen (trigger) once a version leaves `draft`.
- **Map activation (G-07).** Activation is brokered by the worker through a `map.activate` ticket.

### Staff posts (G-08)
Staff posting runs in this order:
1. Create the item as `approved`/`hidden`, with the `public_id` assigned at create.
2. Upload through the same broker.
3. `api_staff_complete_item` enqueues `canonicalize_photo`.
4. When all photos are canonical, `screen_item` runs.
5. `system_record_screening`, or `canonicalize_photo` when screening is off, calls `private.staff_publish_ready`. That moves `hidden -> generating` and enqueues `make_variants`, unless `screening_flags.hold = true`.
6. `api_staff_item_confirm_publish` releases a hold.

### Screening and media (G-24 to G-29, G-37, G-38, G-40)
- **Severe content (G-24).** Severe means adult or violence at VERY_LIKELY; racy is not severe. It sets `screening_flags.quarantine = true`, and only school_admin and above can see the item.
- **Late severe signal (G-24).** If the item is already `generating` or `published`, the system withdraws it, schedules deletion, and writes `alert.severe_content`.
- **Accepted formats (G-25).** No HEIC. The client converts to JPEG. sharp uses `limitInputPixels: 50_000_000`.
- **Screening runs (G-26).** `screening_runs.item_photo_id` is NOT NULL, and each run is unique on `(item_photo_id, policy_version)`.
- **Review rendition (G-28).** Canonicalization also writes a private rendition, `review.jpg` at 800 px on the long edge. It is stored in `item_photos.review_path`, and object kind `review` lives in the `originals` bucket.
- **Error counts (G-29).** `api_record_error` and `system_record_error` upsert `error_rollup(day, signature)`.
- **Photo columns (G-37, G-38).** Adds `items.photo_count`. `item_photos.raw_bytes` is the incoming size; `bytes` is the canonical size.
- **Unscreened items (G-40).** `unscreened`, `error`, and `flagged` items sort ahead of clean ones.

### Staff assertion (G-15, G-16, G-17)
- **Issued-at bound (G-15).** The verifier also requires `iat <= now + 60`.
- **Body binding (G-16).** `body_sha256` is `sha256(canonical_json(body))`. The SQL builds the same `body` jsonb from its own arguments and recomputes the hash. See section 5.
- **Key pointers (G-17).** Two Vault secrets, `staff_assertion_key_current` and `staff_assertion_key_previous`, hold version numbers as text. Only those versions verify.

### Auth, internal secrets, and timeouts (G-18 to G-21)
- **Scheduler bearer (G-18).** The worker compares `sha256(bearer)` with the env value `SCHEDULER_BEARER_SHA256` before any I/O.
- **No worker health route (G-18).** The worker has no `/healthz`.
- **Internal endpoints (G-19).**
  - `/api/internal/revalidate` accepts `Authorization: Bearer <secret>`, checked by sha256 against `REVALIDATE_SECRET_SHA256`. The worker holds `REVALIDATE_SECRET`.
  - `/api/internal/ready` works the same way with `READY_SECRET_SHA256`.
- **Statement timeouts (G-20).** Set by role: `recover_web` 8 s, `recover_worker` 60 s. Functions set only `lock_timeout` (`set local lock_timeout = '3s'`).
- **Default privileges (G-21).** Revoked for `anon`, `authenticated`, and `service_role` in `0002`, and again after everything in `0099`.

### Search (G-22)
- **Accent handling.** `search_tsv` indexes `private.f_unaccent(description)`, and queries are unaccented the same way.
- **Synonym expansion.** Builds OR groups.
- **Trigram matching.** Uses `word_similarity`.

### Remaining gaps (G-31 to G-43)
- **Step-up (G-31).** Destructive actions require a session whose `authTime` is under 10 minutes old; otherwise the staff UI sends the user to sign in again.
- **Device item list (G-32).** `api_my_items`.
- **Leasing (G-33).** The worker leases 1 job at a time in a loop until its budget runs out.
- **Auto-block (G-34).** Implemented inside the API family (`private.maybe_auto_block`).
- **District screening budget (G-35).** Counted in a district-scoped `rate_counters` row.
- **Tenant scope (G-39).** Always derived inside SQL from the school code.
- **Staff-closed reports (G-43).** Adds the lost-report status `closed_by_staff`.

## 4. Error convention

SQL functions fail with `private.fail(code text, detail text default null)`, which raises `errcode 'RV001'`, `message = code`, `detail = detail`. `packages/shared/src/db.ts` turns RV001 into a `PublicError(code, detail)`. The codes and HTTP statuses are:

| Code | HTTP | Meaning |
|---|---|---|
| `not_found` | 404 | resource missing |
| `invalid_input` | 400 | `detail` names the field |
| `rate_limited` | 429 | `detail` is retry seconds |
| `device_blocked` | 403 | |
| `feature_disabled` | 403 | |
| `idempotency_conflict` | 409 | |
| `state_changed` | 409 | a `row_version` or state guard failed |
| `assertion_invalid` | 401 | |
| `forbidden` | 403 | |
| `tenant_mismatch` | 400 | |
| `upstream_unavailable` | 503 | |
| `unauthorized` | 401 | |
| `internal` | 500 | |

Any other error maps to `internal` with a generic message. Never forward raw text.

## 5. Staff assertion (§14.2, v1)

The web sends `p_assert jsonb` as the first argument of every `api_staff_*` and `api_district_*` function:

```json
{ "v":"v1", "request_id":"<uuid lc>", "google_sub":"<sub>", "scope":"school:<uuid lc>|district",
  "operation":"item.approve", "target_id":"<uuid lc>|null", "row_version":7|null,
  "body_sha256":"<64 hex>", "idempotency_key_sha256":"<64 hex>|null", "key_version":1,
  "iat":1790000000, "exp":1790000030, "mac":"<base64url, no padding>" }
```

**MAC input.** Twelve lines joined by `\n`, with no trailing newline. Absent optional fields (`target_id`, `row_version`, `idempotency_key_sha256`) are written as `-`:

`v1`, `request_id`, `google_sub`, `scope`, `operation`, `target_id`, `row_version`, `body_sha256`, `idempotency_key_sha256`, `key_version`, `iat`, `exp`

**MAC.** `HMAC-SHA256(key, utf8(canonical))`, where `key` is 32 bytes. Keys are stored as base64url in the web env var `STAFF_ASSERTION_KEY_CURRENT` (with `STAFF_ASSERTION_KEY_VERSION`) and in the Vault secret `staff_assertion_key_v<n>`.

**Argument types for exact hashing.** In every `api_staff_*` and `api_district_*` function:
- Non-integer numbers (pins, zone centers, radii) and timestamps are declared `text` and cast inside the function.
- JS sends those values as strings: pins as `x.toFixed(6)`, timestamps as the exact ISO string it received.
- UUIDs are lowercased in JS before both the SQL call and the body.
- Integers, booleans, text, uuids, `uuid[]`, and `jsonb` keep their natural types.

This guarantees that JS and SQL hash identical strings.

**Canonical body.** `body` is a JSON object of the function's business arguments, excluding `p_assert`. It is keyed by argument name without the `p_` prefix, keys sorted by code point, with no whitespace. Strings are NFC and escaped exactly as `JSON.stringify` does. Integers are plain, and nulls are included as `null`.
- The JS side builds the object from the same values it passes to SQL.
- The SQL side builds it with `jsonb_build_object` and hashes `private.canonical_json(body)`.

Use only strings, integers, booleans, null, arrays, and objects: no floats. Pins are passed to SQL as floats but put in the body as strings, via `String(x)` in JS and `x::text` in SQL.

**Checks.** `private.assert_staff(p_assert, p_operation, p_school_id uuid, p_target uuid, p_row_version bigint, p_body jsonb)` verifies:
- version, operation, scope, target, and row_version all match;
- the body hash matches;
- the key version is current or previous;
- `exp >= now`, `exp - iat <= 30`, and `iat <= now + 60`;
- the MAC.

It then resolves the membership. It returns the `private.staff_ctx` record `(member_id uuid, user_id uuid, role staff_role, school_id uuid, is_district boolean)` and raises `assertion_invalid` or `forbidden` on failure. A district_admin membership authorizes any school.

**Minimum role per operation** (reviewer < office < school_admin < district_admin):

| Minimum role | Operations |
|---|---|
| reviewer | `queue.read`, `item.read`, `item.approve`, `item.reject`, `item.bulk_reject`, `item.pull`, `item.create`, `item.complete`, `media.read`, `reports.read`, `report.close`, `stats.read` |
| office | `item.receive`, `item.transfer`, `item.claim`, `item.dispose`, `item.bulk_dispose`, `item.edit`, `item.delete`, `item.photo_drop`, `item.confirm_publish`, `device.block`, `device.unblock` |
| school_admin | `roster.read`, `roster.invite`, `roster.update`, `locations.read`, `locations.write`, `zones.write`, `map.read`, `map.create`, `map.upload`, `map.submit`, `config.read`, `config.write`, `calendar.write`, `audit.read` |
| district_admin | `district.*`, `map.activate` |

## 6. SQL function catalog (all `public`, SECURITY DEFINER, `search_path = ''`, return `jsonb`, camelCase keys)

**Call convention.** Every call is `select public.<fn>(p_a => $1, p_b => $2) as r`, with named arguments (see `db.ts`).

**Parameter types**

| Kind | Type | JS value |
|---|---|---|
| school | `text` school code | string |
| digests and HMACs | `bytea` | Buffer |
| ids | `uuid` | string |
| row versions | `bigint` | number |
| pins | `double precision` | number |
| structured edits | `jsonb` | plain object |
| id lists | `uuid[]` | array of strings |

`p_device_digest` is always server-derived from the cookie.

### 6.1 Student and public (owner `recover_api_owner`, EXECUTE to `recover_web`) - A-sql-student

| Function | Args | Returns |
|---|---|---|
| `api_get_meta` | `p_school_code` | `{school:{id,code,name,timezone,flags:{studentPosting,lostReports,crossSchoolSearch},enabledCategories[]}, map:{versionId,path,width,height}\|null, locations:[{id,code,name,hours,pin:{x,y}\|null}], zones:[{id,name,cx,cy,radius}]}`. Flags already AND-ed with the district global switches. `path` is a key in the `maps` bucket. |
| `api_get_feed` | `p_school_code, p_cursor_created timestamptz, p_cursor_id uuid, p_location_id uuid, p_category text, p_since timestamptz` | `{items: PublicItemRow[], nextCursor:{createdAt,id}\|null}` (30 per page) |
| `api_get_item` | `p_school_code, p_public_id` | `PublicItemRow & {location:{id,name,hours}}` |
| `api_search` | `p_school_code, p_q, p_location_id, p_category, p_query_hmac bytea` | `{items: PublicItemRow[]}` (30 max). Inserts `search_events`. |
| `api_search_all` | `p_from_code, p_q, p_query_hmac bytea` | `{items: (PublicItemRow & {schoolCode})[]}`. Requires the district global flag, the source school opt-in, and each target school's opt-in (F-79). |
| `api_device_touch` | `p_school_code, p_device_digest` | `{blocked:boolean, blockedUntil}` (upserts `devices`) |
| `api_rate_take` | `p_school_code, p_action text, p_device_hmac bytea, p_ip_hmac bytea, p_on_campus boolean` | `{ok:true}`, or raises `rate_limited` with retry seconds in `detail`. Limits come from a SQL table mirroring §13.2. Actions: `post_item`, `lost_report`, `search`, `status_poll`. |
| `api_idempotency_begin` | `p_school_code, p_principal_kind, p_operation, p_principal_hmac, p_key_hash, p_request_hash` | `{state:'new'\|'replay'\|'in_progress', responseCode, responseBody}`, or raises `idempotency_conflict` |
| `api_idempotency_finish` | `p_school_code, p_principal_kind, p_operation, p_principal_hmac, p_key_hash, p_response_code int, p_response_body jsonb` | `{ok:true}` |
| `api_create_item_draft` | `p_school_code, p_device_digest, p_category, p_description, p_note, p_map_version_id, p_pin_x, p_pin_y, p_dropoff_location_id, p_photo_count int, p_src text` | `{itemId, photos:[{photoId, position, generation}]}`. Checks flags, device block, high-value categories, and duplicate text. |
| `api_complete_item` | `p_school_code, p_device_digest, p_item_id, p_objects jsonb` (`[{photoId, exists, rawBytes, magicOk}]` from the worker complete-check) | `{itemId, publicId, reviewStatus:'pending', arrivalDeadlineAt}`. Idempotent: a second call returns the same result. |
| `api_item_status` | `p_school_code, p_device_digest, p_item_id` | `{itemId, publicId, reviewStatus, publicationStatus, custody, arrivalDeadlineAt}` |
| `api_my_items` | `p_school_code, p_device_digest` | `{items:[{itemId, publicId, category, createdAt, reviewStatus, publicationStatus, custody}]}` |
| `api_create_lost_report` | `p_school_code, p_device_digest, p_category, p_description, p_map_version_id, p_pin_x, p_pin_y, p_lost_on date` | `{reportId, status, expiresAt}`. Enqueues `match_report`. Allows at most 5 open reports. |
| `api_my_lost_reports` | `p_school_code, p_device_digest` | `{reports:[{id, category, description, status, matchCount, lastMatchedAt, lastViewedAt, expiresAt, rowVersion, matches:[{itemId, publicId, category, description, score, custody, locationId, thumbPath}]}]}`. Matches join through `public_items`. |
| `api_close_lost_report` | `p_school_code, p_device_digest, p_report_id, p_row_version, p_outcome text` (`found` or `dismiss`) | `{reportId, status}` |
| `api_mark_report_seen` | `p_school_code, p_device_digest, p_report_id` | `{ok:true}` |
| `api_record_high_value_redirect` | `p_school_code, p_category` | `{ok:true}` (count only) |
| `api_record_error` | `p_signature text` (at most 120 characters: route plus error class) | `{ok:true}` |
| `api_get_staff_domains` | (none) | `{domains:[]}` |
| `api_health` | (none) | `{db:true, oldestJobS, deadJobs, calendarHorizonD, deletionUnverifiedMaxAgeS, workerHeartbeatAgeS}` |

**`PublicItemRow`**

```json
{ "id", "publicId", "category", "description", "zoneName", "custody", "foundAt", "receivedAt",
  "locationId", "rowVersion",
  "photos": [{ "position", "thumbPath", "mediumPath", "width", "height" }] }
```

There is never a pin, note, device field, or screening field.

### 6.2 Staff (first arg `p_assert jsonb`; owner `recover_api_owner`; EXECUTE to `recover_web`) - A-sql-staff

Every mutation locks the row with `for update`, checks the predecessor state and `row_version`, then writes the audit row and outbox jobs in the same transaction. It returns `{itemId, reviewStatus, publicationStatus, custody, rowVersion}` unless noted otherwise.

**Session and review**
- `api_staff_bind_identity(p_assert, p_google_sub, p_email)` returns `{status:'bound'|'already_bound'|'denied'|'no_invite'}`.
- `api_staff_resolve_session(p_assert, p_google_sub)` returns `{user:{id,email,displayName}, memberships:[{memberId, schoolId, schoolCode, schoolName, role, status}]}`. On the first successful resolve, invited memberships are set to active.
- `api_staff_queue(p_assert, p_school_code, p_cursor_created, p_cursor_id)` returns `{items: StaffItemRow[], nextCursor}`, 50 per page. Quarantined items appear only for school_admin and above.
- `api_staff_item_get(p_assert, p_school_code, p_item_id)` returns `StaffItemRow`.
- `api_staff_item_approve(p_assert, p_school_code, p_item_id, p_row_version, p_edits jsonb)`. `p_edits` may contain description, category, zoneId, and dropoffLocationId. The item moves to `pending -> approved`, publication to `generating`, and `make_variants` is enqueued.
- `api_staff_item_reject(p_assert, p_school_code, p_item_id, p_row_version, p_reason)`. Also inserts a `device_rejections` row, runs `private.maybe_auto_block`, and schedules `anonymize_rejected`, which handles deletion.
- `api_staff_bulk_reject(p_assert, p_school_code, p_item_ids uuid[], p_reason)` returns `{rejected, skipped:[]}`.

**Custody and item changes**
- `api_staff_item_receive(p_assert, p_school_code, p_item_id, p_row_version, p_location_id)` handles `with_finder` and late arrival.
- `api_staff_item_transfer(p_assert, p_school_code, p_item_id, p_row_version, p_location_id)`.
- `api_staff_item_claim(p_assert, p_school_code, p_item_id, p_row_version)`.
- `api_staff_item_dispose(p_assert, p_school_code, p_item_id, p_row_version, p_disposition)` takes `donated` or `disposed`.
- `api_staff_bulk_dispose(p_assert, p_school_code, p_item_ids uuid[], p_disposition)`.
- `api_staff_item_pull(p_assert, p_school_code, p_item_id, p_row_version, p_reason)`.
- `api_staff_item_delete(p_assert, p_school_code, p_item_id, p_row_version, p_reason)`.
- `api_staff_item_edit(p_assert, p_school_code, p_item_id, p_row_version, p_edits jsonb)`.
- `api_staff_item_confirm_publish(p_assert, p_school_code, p_item_id, p_row_version)`.
- `api_staff_photo_drop(p_assert, p_school_code, p_item_id, p_photo_id, p_row_version)`.

**Staff posts and devices**
- `api_staff_create_item(p_assert, p_school_code, p_mode, p_category, p_description, p_note, p_map_version_id, p_pin_x, p_pin_y, p_location_id, p_photo_count)`. `p_mode` is `staff` or `backfill`. Returns `{itemId, publicId, photos:[{photoId, position, generation}]}`.
- `api_staff_complete_item(p_assert, p_school_code, p_item_id, p_objects jsonb)`.
- `api_staff_block_device(p_assert, p_school_code, p_item_id, p_report_id, p_days int, p_reason)`.
- `api_staff_unblock_device(p_assert, p_school_code, p_item_id, p_report_id)`.
- `api_staff_media_ticket(p_assert, p_school_code, p_operation, p_photo_id, p_map_version_id)` returns `{ticketId, expiresAt}`. `p_operation` is one of `media.read`, `map.upload`, `map.read`, `map.activate`.

**Lost reports and roster**
- `api_staff_lost_reports(p_assert, p_school_code)` returns `{reports:[{id, category, description, pin, mapVersionId, createdAt, matchCount, status, rowVersion}]}`. No device data.
- `api_staff_report_close(p_assert, p_school_code, p_report_id, p_row_version)` sets `closed_by_staff`.
- `api_staff_roster_list(p_assert, p_school_code)`.
- `api_staff_roster_invite(p_assert, p_school_code, p_email, p_role, p_display_name)`. Cannot grant `district_admin`.
- `api_staff_roster_update(p_assert, p_school_code, p_member_id, p_role, p_status)`.

**Locations, maps, and zones**
- `api_staff_locations_list(p_assert, p_school_code)`.
- `api_staff_location_upsert(p_assert, p_school_code, p_location_id, p_code, p_name, p_hours, p_active)`.
- `api_staff_location_pin_set(p_assert, p_school_code, p_location_id, p_map_version_id, p_x, p_y)`.
- `api_staff_map_versions(p_assert, p_school_code)`.
- `api_staff_map_create_draft(p_assert, p_school_code)` returns `{mapVersionId}`.
- `api_staff_zone_upsert(p_assert, p_school_code, p_map_version_id, p_zone_id, p_name, p_cx, p_cy, p_radius, p_active)`. Drafts only.
- `api_staff_map_submit(p_assert, p_school_code, p_map_version_id)`.

**Config, stats, and audit**
- `api_staff_config_get(p_assert, p_school_code)`.
- `api_staff_config_update(p_assert, p_school_code, p_changes jsonb)`.
- `api_staff_calendar_upsert(p_assert, p_school_code, p_days jsonb)`. `p_days` is `[{day, isOpen, openAt, closeAt}]`.
- `api_staff_stats(p_assert, p_school_code, p_from date, p_to date)`.
- `api_staff_audit(p_assert, p_school_code, p_limit int)`.

**`StaffItemRow`**

```json
{ "id", "publicId", "category", "description", "note", "pin":{ "x", "y" }|null, "mapVersionId", "zoneId", "zoneName",
  "dropoffLocationId", "currentLocationId", "reviewStatus", "publicationStatus", "custody", "postedByKind",
  "createdAt", "arrivalDeadlineAt", "expiresAt", "dispositionDueAt", "rowVersion", "screeningStatus",
  "flags":[string], "quarantine":boolean,
  "photos":[{ "photoId", "position", "generation", "status", "isCurrent" }],
  "deviceRejections30d":int|null }
```

### 6.3 District (scope `district`) - A-sql-staff

- `api_district_schools_list(p_assert)`.
- `api_district_school_create(p_assert, p_code, p_name, p_timezone, p_admin_email, p_admin_name)`. Validates the timezone against `pg_timezone_names`.
- `api_district_settings_get(p_assert)`.
- `api_district_settings_update(p_assert, p_changes jsonb)`. Covers floor and ceiling, domains, global switches, screening ceiling, and worker mode.
- `api_district_maps_pending(p_assert)`.
- `api_district_map_reject(p_assert, p_map_version_id, p_reason)`.
- `api_district_identity_rebind(p_assert, p_staff_user_id)`. Clears `google_sub` and writes an audit row.
- `api_district_stats(p_assert, p_from, p_to)`.
- `api_district_alerts(p_assert, p_limit)`.
- `api_district_onboarding(p_assert, p_school_code)` returns the steps and their status (§24).

### 6.4 System (owner `recover_system_owner`, EXECUTE to `recover_worker`) - A-sql-system

**Job queue**
- `system_lease_jobs(p_worker_id text, p_kinds text[], p_limit int, p_lease_seconds int)` returns `{jobs:[{id, kind, payload, schoolId, attempts, maxAttempts}]}`. Pass `p_kinds` null for all kinds; honors `worker_mode`.
- `system_job_done(p_job_id bigint)`.
- `system_job_fail(p_job_id, p_error_code, p_retry_after_s int, p_permanent boolean)`.
- `system_reap_leases()` returns `{requeued, dead}`.
- `system_worker_heartbeat(p_worker_id)`.

**Uploads and canonicalization**
- `system_get_upload_spec(p_item_id, p_school_id)` returns `{schoolId, itemId, photos:[{photoId, position, key}]}`. Only for a draft student item, or a hidden staff item whose photos are `uploaded`.
- `system_get_complete_spec(p_item_id, p_school_id)` returns the expected `{photos:[{photoId, key}]}` for the HEAD check.
- `system_get_photo(p_photo_id)` returns `{photoId, itemId, schoolId, status, incomingPath, originalPath, reviewPath, thumbPath, mediumPath, publicObjectToken (hex|null), isCurrent}`.
- `system_photo_canonical_ready(p_photo_id, p_original_path, p_review_path, p_bytes int, p_width int, p_height int, p_fingerprint bytea)` returns `{allCanonical}`. Sets duplicate flags. When all photos are canonical, enqueues `screen_item`, or calls staff publish-ready when screening is off.
- `system_photo_incoming_cleared(p_photo_id)`.
- `system_photo_failed(p_photo_id, p_failure_code)`.

**Screening**
- `system_screening_budget_take(p_images int)` returns `{allowed, enabled}`.
- `system_record_screening(p_item_id, p_photo_id, p_provider, p_model, p_policy_version, p_status, p_signals jsonb)`. Idempotent on `(photo, policy)`. Aggregates flags, applies the severe-content rules, and runs staff publish-ready.

**Variants and publishing**
- `system_variant_targets(p_item_id)` returns `{photos:[{photoId, originalPath, token}]}`. The token is hex, generated once and stored.
- `system_photo_variants_ready(p_photo_id, p_thumb_path, p_medium_path)`.
- `system_finalize_publish(p_item_id)` returns `{published}`. When publishing, enqueues `invalidate_cache` and `match_item`.

**Media tickets and deletion**
- `system_media_ticket_redeem(p_ticket_id, p_operation)` returns `{schoolId, operation, photoId, reviewPath, originalPath, mapVersionId, draftPath, draftCanonicalPath}`. Single use; checks expiry.
- `system_deletion_objects(p_ledger_id)` returns `{objects:[{photoId, objectKind, bucket, storagePath, deletedAt, verifiedAt}]}`.
- `system_deletion_object_done(p_ledger_id, p_photo_id, p_object_kind, p_verified boolean)`.
- `system_media_ledger_verified(p_ledger_id)`.

**Scheduled maintenance**
- `system_expire_never_arrived()`, `system_mark_disposition_due()`, `system_expire_reports()`, `system_anonymize_rejected()`, `system_clear_terminal_item_text()`, `system_reconcile_generating()`, `system_rollup_daily_stats(p_day date)`, and `system_evaluate_alerts()`. Each returns `{count}`.
- `system_purge(p_kind text)` returns `{count}`. `p_kind` is one of: `devices`, `device_links`, `closed_reports`, `report_matches`, `idempotency_keys`, `search_events`, `health_checks`, `rate_counters`, `jobs`, `screening_runs`, `deletion_evidence`, `device_rejections`, `media_tickets`.
- `system_drafts_to_purge()` returns `{items:[{itemId, schoolId, incomingPaths:[]}]}`.
- `system_purge_draft(p_item_id)`.

**Matching and maps**
- `system_match_candidates_for_item(p_item_id)` and `system_match_candidates_for_report(p_report_id)` return `{pairs:[{reportId, itemId, lex, sameCategory, reportCategoryNull, foundAt, lostOn, sameMapVersion, dx, dy, mapWidth, mapHeight}]}`.
- `system_record_match(p_report_id, p_item_id, p_score, p_features jsonb, p_scorer_version)`.
- `system_map_get(p_map_version_id)`.
- `system_map_canonical_ready(p_map_version_id, p_canonical_path, p_width, p_height)`.
- `system_map_activate(p_ticket_id, p_public_path)`. The ticket must be `map.activate`. Retires the previous version and enqueues `delete_map_draft`.
- `system_map_draft_deleted(p_map_version_id)`.

**Health**
- `system_record_error(p_signature)`.
- `system_health_record(p_detail jsonb)`.

Periodic work is enqueued by `pg_cron` SQL calls to `private.enqueue_periodic(kind)`, defined in `0450_cron.sql`. The cadence follows §8.3, plus `expire_reports` every 15 min (G-13).

## 7. Job catalog (worker modules in `apps/worker/lib/jobs/<kind>.ts`)

| Kind | Payload | Dedupe key | Notes |
|---|---|---|---|
| `canonicalize_photo` | `{photoId}` | `canonicalize_photo:<photoId>` | sharp; writes canonical and review renditions; deletes raw; lease 120 s |
| `screen_item` | `{itemId, policyVersion}` | `screen_item:<itemId>:<policy>` | budget, then Vision (or mock) per current photo |
| `make_variants` | `{itemId}` | `make_variants:<itemId>` | lease 120 s; then enqueues `finalize_publish` |
| `finalize_publish` | `{itemId}` | `finalize_publish:<itemId>` | |
| `match_item` | `{itemId}` | `match_item:<itemId>:<rowVersion>` | scorer in `packages/shared/src/matcher.ts` |
| `match_report` | `{reportId}` | `match_report:<reportId>` | |
| `invalidate_cache` | `{tags:[]}` | `invalidate_cache:<sortedTags>:<txid>` | POST to web `/api/internal/revalidate` |
| `delete_media` | `{ledgerId}` | `delete_media:<ledgerId>` | 404 is success; verify with HEAD |
| `canonicalize_map` | `{mapVersionId}` | `canonicalize_map:<id>` | long edge 2400 |
| `delete_map_draft` | `{mapVersionId}` | `delete_map_draft:<id>` | |
| `expire_never_arrived`, `mark_disposition_due`, `expire_reports`, `anonymize_rejected`, `clear_terminal_item_text`, `reconcile_generating`, `evaluate_alerts` | `{}` | `<kind>:<yyyy-mm-ddThh:mi>` | each calls its `system_*` function |
| `rollup_daily_stats` | `{day}` | `rollup_daily_stats:<day>` | |
| `purge` | `{kind}` | `purge:<kind>:<day>` | |
| `purge_drafts` | `{}` | | deletes incoming objects, then the rows |
| `reconcile_orphan_uploads` | `{}` | | lists `incoming` via S3 ListObjectsV2 |

## 8. Storage keys (bucket-relative; DB columns store keys, not URLs)

| Bucket | Key | Notes |
|---|---|---|
| `incoming` | `{schoolId}/{itemId}/{photoId}/raw` | 1 MiB limit; jpeg, png, or webp |
| `originals` | `{schoolId}/{itemId}/{photoId}/canonical.jpg` | |
| `originals` | `{schoolId}/{itemId}/{photoId}/review.jpg` | |
| `variants` | `{schoolId}/{itemId}/{photoId}/{tokenHex}/thumb.jpg` and `.../medium.jpg` | public |
| `map_drafts` | `{schoolId}/{mapVersionId}/draft` | raw upload |
| `map_drafts` | `{schoolId}/{mapVersionId}/canonical.jpg` | |
| `maps` | `{schoolId}/{mapVersionId}/{tokenHex}.jpg` | public |

The public URL is `${STORAGE_PUBLIC_URL}/<bucket>/<key>`. The web builds URLs, and SQL returns keys only.

## 9. Routes

### 9.1 Student (A-student)

**Pages**
- `/s/[code]`: feed, search box, "Found something", "I lost something", and a "Your lost reports" badge.
- `/s/[code]/found`: client wizard with steps category, photos, where, describe, submit, done.
- `/s/[code]/items/[publicId]`: listing.
- `/s/[code]/search`: search results.
- `/s/[code]/lost`: lost-report form.
- `/s/[code]/lost/mine`: this device's lost reports.
- `/s/[code]/mine`: this device's posted items.
- `/offline`: the unavailable page.

**API**
- `GET /api/s/[code]/meta`
- `GET /api/s/[code]/items`
- `GET /api/s/[code]/items/[publicId]`
- `GET /api/s/[code]/search`
- `GET /api/search-all`
- `POST /api/s/[code]/items`: create the draft, then call worker `upload-spec`; returns `{itemId, uploads:[{photoId, position, url, expiresAt}]}`.
- `POST /api/s/[code]/items/[itemId]/complete`: call worker `complete-check`, then `api_complete_item`.
- `GET /api/s/[code]/items/[itemId]/status`
- `GET /api/s/[code]/my-items`
- `POST /api/s/[code]/lost-reports`
- `GET /api/s/[code]/lost-reports`
- `POST /api/s/[code]/lost-reports/[id]/close`
- `POST /api/s/[code]/lost-reports/[id]/seen`
- `POST /api/s/[code]/events/high-value`
- `POST /api/client-error`

**Guard order for mutations** (§8, "Route handler skeleton"):
1. Same origin, `Sec-Fetch-Site`, and `X-Recover-Request: 1`.
2. Resolve the school.
3. Device cookie and digest.
4. Rate limit.
5. Parse and validate (NFC, controls, lengths).
6. Idempotency, where the spec requires it (create, complete, lost report).
7. Call the function.
8. Respond with `request_id` echoed.

### 9.2 Staff and district (A-staff)

**Pages**
- `/staff/signin`
- `/staff`: school picker.
- `/staff/[code]/queue`
- `/staff/[code]/items/[id]`
- `/staff/[code]/custody`
- `/staff/[code]/post`, with `?mode=backfill` for backfill.
- `/staff/[code]/reports`
- `/staff/[code]/roster`
- `/staff/[code]/locations`
- `/staff/[code]/map`
- `/staff/[code]/config`
- `/staff/[code]/stats`
- `/district`
- `/district/schools`
- `/district/maps`
- `/district/settings`
- `/district/stats`

**Staff API** (under `/api/staff/[code]/...`), one route per function in section 6.2:
- `queue`
- `items` (POST create); `items/[id]` (GET, PATCH edit, DELETE soft delete)
- `items/[id]/{approve,reject,receive,transfer,claim,dispose,pull,confirm-publish,complete,block-device,unblock-device}`
- `items/bulk-reject`, `items/bulk-dispose`
- `items/[id]/photos/[photoId]`: issues a ticket, then streams through the worker.
- `items/[id]/photos/[photoId]/drop`
- `reports`, `reports/[id]/close`
- `roster`, `roster/[memberId]`
- `locations`, `locations/[id]/pin`
- `maps`, `maps/[versionId]/{upload,zones,submit,image}`
- `config`, `calendar`, `stats`, `audit`

**District API** (under `/api/district/...`)
- `schools`, `settings`, `maps`
- `maps/[versionId]/activate`: ticket, then worker `map-activate`.
- `maps/[versionId]/reject`
- `identity/[userId]/rebind`
- `stats`, `alerts`

**Internal**
- `POST /api/internal/revalidate`: body `{tags:[]}`; calls `revalidateTag(tag, 'max')`.
- `GET /api/internal/ready`
- `/api/auth/[...nextauth]`

### 9.3 Worker (A-worker)

Every handler authenticates first and returns an empty 401 on failure (F-123).

| Route | Auth | Body | Behavior |
|---|---|---|---|
| `POST /api/jobs/run` | scheduler bearer | none | drain loop within 50 s |
| `POST /api/media/upload-spec` | web | `{itemId, schoolId}` | returns `{uploads:[{photoId, position, url, expiresAt}]}` |
| `POST /api/media/complete-check` | web | `{itemId, schoolId}` | returns `{objects:[{photoId, exists, rawBytes, magicOk}]}` |
| `GET /api/media/ticket/[ticketId]` | web | none | streams `review.jpg`, or the canonical image with `?full=1`, or a map draft or map for map tickets; `Cache-Control: private, no-store` |
| `POST /api/media/map-draft` | web | `{ticketId}` | returns a presigned PUT for the map draft |
| `POST /api/media/map-activate` | web | `{ticketId}` | copies the canonical map to the `maps` bucket, then calls `system_map_activate` |

**Web identity for the worker**
- **Production:** `Authorization: Bearer <Vercel OIDC token>`, verified with `jose` against the pinned `iss`, `aud`, `sub`, and environment.
- **Development:** header `X-Recover-Dev-Secret: <WORKER_DEV_SECRET>`, accepted only when `RECOVER_DEV_AUTH=1` and `process.env.VERCEL` is unset.

The web helper `apps/web/lib/worker.ts` adds the right header.

## 10. Environment variables

### 10.1 Web (`apps/web/.env.local`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | database connection for `recover_web` |
| `DATABASE_SSL` | `disable` locally; `require` in production |
| `AUTH_SECRET` | Auth.js session secret |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | optional locally |
| `RECOVER_DEV_LOGIN=1` | enables the dev Credentials login; refused when `VERCEL` is set |
| `STAFF_ASSERTION_KEY_CURRENT`, `STAFF_ASSERTION_KEY_VERSION` | assertion minting (section 5) |
| `DEVICE_KEY_V1`, `IP_KEY`, `SEARCH_KEY` | base64url 32-byte keys |
| `WORKER_URL` | where the worker runs |
| `WORKER_DEV_SECRET`, `RECOVER_DEV_AUTH=1` | dev-only worker authentication |
| `STORAGE_PUBLIC_URL` | public object base URL |
| `S3_ORIGIN` | for CSP `connect-src` |
| `REVALIDATE_SECRET_SHA256`, `READY_SECRET_SHA256` | internal endpoint secrets (hashes) |
| `WEB_ORIGIN` | the web app's own origin |

### 10.2 Worker (`apps/worker/.env.local`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | database connection for `recover_worker` |
| `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION` | S3 endpoint |
| `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` | S3 keys (worker only) |
| `CONTENT_KEY` | fingerprint HMAC key |
| `SCHEDULER_BEARER_SHA256` | scheduler bearer hash |
| `WORKER_DEV_SECRET`, `RECOVER_DEV_AUTH=1` | dev-only web authentication |
| `WEB_OIDC_ISSUER`, `WEB_OIDC_AUDIENCE`, `WEB_PROJECT_ID`, `WEB_OWNER_ID` | production OIDC pins for recover-web's Vercel token (`https://oidc.vercel.com/<team-slug>`, `https://vercel.com/<team-slug>`) |
| `VISION_MODE` | `mock`, `google`, or `off` |
| `VISION_MOCK_FLAG=1` | tests only: mock screening reports text on every image |
| `GCP_WIF_AUDIENCE`, `GCP_SERVICE_ACCOUNT_EMAIL` | Google identity federation |
| `WEB_URL`, `REVALIDATE_SECRET` | for cache revalidation calls |

`scripts/dev-env.mjs` writes both `.env.local` files with fresh random keys and the local `supabase status` values.

## 11. Shared module APIs (packages/shared/src)

- **db.ts** (lead)
  - `createDb(url, {ssl, max})`
  - `callApi<T>(sql, 'api_x', {p_a: ...})`, `callSystem<T>(sql, 'system_x', {...})`
  - `PublicError` is re-exported from `errors.ts`.
- **errors.ts** (lead)
  - `PublicError`, `errorResponse(e, requestId)`, `toPublicError(e)`
  - `PUBLIC_ERRORS` table with status and message.
- **dto.ts** (lead): types for every JSON shape in section 6.
- **crypto.ts** (lead; already written): `sha256`, `sha256Hex`, `hmacSha256`, `b64url`, `fromB64url`, `randomToken`, `uuidBytes`, `deviceDigest(keyB64url, version, schoolId, tokenBytes)` (version byte followed by `HMAC(key, schoolIdBytes || token)`), `monthlyHmac(keyB64url, purpose, value)`, `timingSafeEqualStr`, `secretMatchesSha256(presented, expectedHex)`.
- **assertion.ts** (lead; already written)
  - `canonicalJson(value)`, `bodySha256(body)`
  - `canonicalLines(fields)` (the twelve lines), `macFor(fields, keyB64url)`
  - `mint({googleSub, scope, operation, targetId, rowVersion, body, idempotencyKeySha256, keyB64url, keyVersion, requestId?, now?}): AssertionBundle`: the jsonb bundle passed as `p_assert`.
- **sigv4.ts** (A-shared)
  - `presignPut({endpoint, region, accessKeyId, secretAccessKey, bucket, key, expiresSeconds, now?}): {url, expiresAt}`
  - `signRequest({method, endpoint, region, accessKeyId, secretAccessKey, bucket, key, query?, headers?, body?, now?}): {url, headers}`
  - Path-style URLs, service `s3`.
- **unicode.ts** (A-shared): `cleanText(s, {min, max, field}): string` returns NFC-normalized, whitespace-collapsed text. It throws `PublicError('invalid_input', field)` on C0/C1 or bidi controls or on length.
- **rate.ts** (A-shared): the limits table mirroring §13.2, and `classifyIp(ip, cidrs)`.
- **log.ts** (A-shared): `log(level, event, fields)`, which writes one JSON line through a denylist scrubber.
- **matcher.ts** (A-shared): `score(pair): {score, features}`, `SCORER_VERSION = 'v1'`, weights, and a threshold of 0.55 (§12).
- **retention.ts** (A-shared): the table in `14` plus the additions.
- **audit.ts** (A-shared): TS mirror of the per-action audit allowlists; SQL enforces the same lists.
- **env.ts** (A-shared): `requireEnv(names[])`. It is called only by the apps, never by the shared modules.

## 12. Git workflow (owner rules, mandatory)

Remote: `origin` = https://github.com/SriramBarla/Recover (PUBLIC). Never commit secrets, `.env*` files, or anything under `files (16)/`.

1. **One branch per feature.** Name it `feat/<area>`. Agents work only in their own worktree and branch. Nobody commits to `main` directly.
2. **Commit and push often.** Commit after every coherent step (roughly 30 to 60 minutes of work). Push with `git push -u origin <branch>`.
3. **Message style.** Use an imperative subject with an area prefix, for example `db: add item CHECKs (G-02, G-03)`. Commit messages carry NO co-author or attribution trailers of any kind.
4. **Finish with a pull request.** When the feature is done, open a PR against `main`: `gh pr create --base main --head <branch> --title "<area>: <summary>" --body "<what, why, tests run, known gaps>"`. Add no attribution footer.
5. **The lead merges.** Agents do not merge. The lead merges PRs in dependency order, resolving conflicts, with `gh pr merge <n> --merge --delete-branch`.
6. **Stay in your lane.** If you need a change in a file you do not own, describe it in the PR body and final report. Do not edit it.
7. **Dependencies in a worktree.** A fresh worktree has no `node_modules`. Link the main checkout's copy with `ln -s /Users/sriram_barla/Desktop/Recover/Recover/node_modules node_modules` at the worktree root. Never run `npm install`.

## 13. Additions made during the build (authoritative)

These were agreed between agents while building and are now part of the contract.

**SQL, staff side**
- `api_staff_custody_list(p_assert, p_school_code, p_location_id)` has operation `item.read` and a null target. It returns `{expected, atLocation, dispositionDue}`, each a `StaffItemRow[]` of at most 200 rows. Quarantined items are shown to school_admin and above only.
- The staff operation, scope, and target table in `apps/web/lib/ops.ts` (`FNS`) is authoritative for every `api_staff_*` and `api_district_*` call.

**SQL, system side**
- `system_screening_targets(p_item_id, p_policy_version)` returns `{photos:[{photoId, originalPath}]}`: current photos in `canonical_ready` or `public_ready` that have no screening run for that policy yet.
- `system_media_ticket_redeem` also returns `itemId` and `publicPath`.
- `system_deletion_objects` rows also carry `found`, `schoolId`, `itemId`, and `currentPath`.
- `system_purge` kinds include `map_drafts`. That purge first rejects any draft not submitted within 7 days of creation (reason `abandoned: not submitted within 7 days`, audit action `map.abandon`), then queues `delete_map_draft` for rejected versions.
- `system_purge` kinds also include `error_rollup`: day rows go 90 days after their UTC day (0410).
- `system_map_get(p_map_version_id)` returns `{mapVersionId, schoolId, approvalStatus, active, draftPath, draftCanonicalPath, publicPath, width, height}`. An unknown id is `not_found`.
- Redeeming a `map.upload` ticket schedules `canonicalize_map` 60 s later.

**Rate limits**
- The actions are `post_item`, `lost_report`, `search`, `status_poll`, `search_all`, `high_value`, and `client_error`. `search_all` has its own budget, the same size as `search`.
- `high_value` (`POST /api/s/[code]/events/high-value`) and `client_error` (`POST /api/client-error`) are per address only: 20 and 60 per 10 minutes. `client_error` has no school, so it takes `p_school_code` null and its counters use the `district` scope (0210).
- `api_record_error` signatures may contain one space (`<METHOD> <route>:<Class>`), and the client-error beacon accepts only allowlisted classes and routes.
- Counters are keyed per window (`<action>:<window>`), so the day and week post limits never share a row.

**Deletion and publication rules**
- The never-arrived deletion ledger uses reason `never_arrived`. A late check-in cancels only that reason.
- `private.staff_publish_ready(force)` releases a hold, never a quarantine.
- A late severe signal on a published item deletes the public variants and keeps the private originals for the incident responders.

**Cache**
- Staff mutations that change what students see (claim, dispose, pull, delete, edit, receive, transfer, photo drop) expire `school:<id>` synchronously with `revalidateTag(tag, { expire: 0 })`.
- The outbox `invalidate_cache` job expires the same tags through `/api/internal/revalidate`.

**Calendar**
- `0011_calendar_recompute.sql` recomputes open arrival deadlines for the edited school only, whenever its `school_calendar_days`, `never_arrived_school_days`, or timezone changes (G-01).
- A recompute counts from `items.arrival_basis_at`, the completion time `/complete` stores. It only moves a deadline later, or fills one that missing coverage left NULL. It never moves one earlier.

**Staff sign-in (web/worker security review, PR #26)**
- The step-up sign-in (`?reauth=1`) sends `prompt=login` and `max_age=0`. The session's auth time comes from the ID token's `auth_time`, falling back to the server clock if the claim is missing ([VERIFY] V-6: confirm Google sends `auth_time` on this client). The 24-hour session limit runs from `signedInAt`.
- Dev login and dev worker auth are refused when `NODE_ENV` is `production` as well as on Vercel.
- The staff complete route checks the item in SQL before it calls the worker.

**Security review fixes (database, PR #27)**
- pg_net is never installed. `private.cron_drain()` calls the worker synchronously through the `http` extension, so the bearer is never stored in a table. A 5 s timeout is the normal outcome; any other failure fails the cron run with the HTTP status or the connection error.
- `api_staff_create_item` and `api_staff_map_create_draft` claim the assertion's idempotency key, or its `request_id` when there is none, in `idempotency_keys` (principal kind `staff`, operations `item.create` and `map.create`). A replay returns the first result. The same key with a different body is `idempotency_conflict`.
- `recover_attestation_owner` reads `private.staff_assertion_keys` (the `staff_assertion_key_*` rows) and has no grant on `vault.decrypted_secrets`.
- The login roles have USAGE on `public` only, apart from the catalogs. `supabase/tests/security_review.sql` checks all of the above.

**Device-key rotation (T-825; 13 Implementation guide "Device cookie issuance"; RUNBOOK.md section 21)**
- Web env: `DEVICE_KEY_CURRENT` is the version every digest is written and looked up with (default 1). `DEVICE_KEY_PREVIOUS` is set only during a rotation window and must differ. Each of the two versions needs its `DEVICE_KEY_V<n>` (32 bytes, base64url), so `DEVICE_KEY_V1` is required only while version 1 is current or previous. Startup logs `device_keys_invalid` or `device_keys_unused`, naming variables only.
- `api_device_rekey(p_school_code, p_old_digest, p_new_digest)` is in the 6.1 family (owner `recover_api_owner`, EXECUTE to `recover_web`). It returns counts `{items, lostReports, deviceRejections, devices, rateCounters, idempotencyKeys}` and moves one browser's rows at one school from its previous-key digest to its current-key digest:
  - `items.device_token_hash` and `lost_reports.device_token_hash` (any status);
  - `devices`, merged into an existing current-key row: the older `first_seen_at`, the later `last_seen_at`, and the block that runs later;
  - `device_rejections`;
  - device `rate_counters`, where counts of the same window add up;
  - device `idempotency_keys`, where a current-key row for the same key wins.

  Both digests must be 33 bytes with different version bytes. The call is idempotent and writes no audit row and no job. A moved item or report gets a new `row_version`.
- During a window, `getDevice` (route handlers) and `cookieDigest` (Server Components) in `apps/web/lib/device.ts` call it for an existing cookie before the request's first device-bound call. A failed move fails the request. Outside a window nothing extra runs.
- The api family gains DELETE on `devices`, `rate_counters`, and `idempotency_keys` (rows move as delete + upsert), and UPDATE of `device_rejections.device_token_hash`. Index `reports_device_link` covers `lost_reports (school_id, device_token_hash)` where the digest is set. `supabase/tests/device_rekey.sql` checks the move.

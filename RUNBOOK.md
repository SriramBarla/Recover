# Recover runbooks

These are the operational procedures for Recover: the 24 headings of §23 (`19-Operations-Runbooks.md`), adapted to this implementation. Every section uses the same format: **Trigger**, **Severity** (school, district, or incident), **Owner**, **Steps**, **Verify**, and **Record**.

> **Start with incident 3.** A published item that should never have been approved is the incident that ends the project if it is handled badly. Its section comes first. The target is **15 minutes from the pull to verified deletion**. Rehearse it every quarter on staging.

The other sections follow in §23 order: [1](#1-queue-backlog-at-a-school) · [2](#2-screening-provider-outage) · [4](#4-suspected-abuse-pattern-from-one-device-or-campus) · [5](#5-staff-offboarding) · [6](#6-school-map-replacement) · [7](#7-end-of-term-disposition-day) · [8](#8-key-rotation) · [9](#9-restore-from-backup) · [10](#10-adding-a-school) · [11](#11-sunset--read-only-mode) · [12](#12-restore-quarantine) · [13](#13-worker-stuck--dead-letter) · [14](#14-screening-ceiling-reached) · [15](#15-privacy--deletion-request) · [16](#16-suspected-tenant-isolation-defect) · [17](#17-staff-assertion-key-rotation--emergency-revocation) · [18](#18-orphan-storage-reconciliation) · [19](#19-public-map-review) · [20](#20-worker-scheduler-fallback) · [21](#21-device-key-rotation) · [22](#22-storage-root-credential-incident) · [23](#23-calendar-horizon) · [24](#24-audit-privacy-review)

## How to use this file

**Where problems show up.** Recover pages nobody (§0.5). Signals are pull-based:

- **District alerts** appear as a banner at `/district`. They are the last 24 hours of `alert.<name>` audit rows written by `system_evaluate_alerts`, which runs after every 5-minute health check:
  - `oldest_job`, `dead_jobs`, `worker_stale`, `health_failing`, `health_gap`
  - `screening_error_rate`, `screening_budget`
  - `deletion_unverified_warning` (over 1 h), `deletion_unverified_high` (over 24 h), `deletion_unverified_breach` (over 7 d)
  - `storage`, `egress`
  - `queue_age` and `calendar_horizon`, which are also shown per school on `/staff/<CODE>/stats`
  - `severe_content`, written by `system_record_screening` when a severe signal arrives after approval (G-24)
- **Health numbers** as the admin: `select public.api_health();` returns `oldestJobS`, `deadJobs`, `calendarHorizonD`, `deletionUnverifiedMaxAgeS`, and `workerHeartbeatAgeS`.

**Where things are done.**

- **Staff and school admins** work under `/staff/<CODE>/`: `queue`, `items/<id>`, `custody`, `post`, `reports`, `roster`, `locations`, `map`, `config`, `stats`.
- **District admins:** `/district`, `/district/schools`, `/district/maps`, `/district/settings`, `/district/stats`.
- **Operators:** the scripts below.

**Operator scripts** (`node scripts/<name>.mjs`, from a checkout on an admin machine):

| Script | Does | Runbooks |
|---|---|---|
| `switch.mjs --district k=v ...` / `--school CODE k=v ...` | global and school switches, `worker_mode` | 1, 2, 3, 4, 11, 12, 16, 22 |
| `rotate-db-password.mjs --role recover_web\|recover_worker` | new login password (SCRAM verifier), Vercel steps | 8, 16 |
| `rotate-assertion-key.mjs --next\|--finish\|--emergency` | staff-assertion key and Vault pointers (G-17) | 8, 16, 17 |
| `restore-quarantine.mjs --begin\|--reopen` | restore quarantine (§16.5, G-06) | 9, 12 |
| `jobs.mjs --summary\|--dead\|--running\|--replay\|--dispose\|--enqueue` | outbox inspection and replay | 2, 7, 13, 20 |
| `calendar-horizon.mjs [--school CODE] [--extend file.csv]` | calendar coverage (F-88) | 10, 23 |
| `audit-privacy-sample.mjs` | audit payload privacy check (F-74) | 24 |
| `reconcile-orphans.mjs` | storage against DB paths | 9, 12, 18, 22 |
| `qr-posters.mjs --school CODE --halls A,B` | printable SVG posters (F-99) | 10 |
| `load-synonyms.mjs` | `packages/shared/src/synonyms.json` into `public.synonyms` | 10 |

**Rules that apply to every script:**

- **Dry run by default.** Each script prints its plan and changes nothing. `--yes` applies the plan, and `--dry-run` wins over `--yes`.
- **Audit row.** Every change writes one `audit_log` row with `actor_kind = 'system'`, `actor_id = 'runbook:<script>'`, and `action = 'runbook.<name>'`. The script prints its `request_id`; copy it into the record.
- **Database connection.** Scripts connect as the `postgres` admin, never with the app logins and never through the transaction pooler (port 6543). They take the URL from `--db`, else env `DB_URL`, else `DB_URL=` in the repo-root `.env.local`, else the local stack. Use one of:
  - the **direct** connection, `postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres` (IPv6 unless the IPv4 add-on is enabled);
  - on an IPv4-only network, the **session pooler**, `postgresql://postgres.<ref>:<pw>@<region pooler host>:5432/postgres`. Note the user `postgres.<ref>` and port 5432.

  In production, keep the password off the command line and out of shell history: `read -rs DB_URL && export DB_URL`.
- **TLS.** Download the Supabase CA from Dashboard > Database > SSL Configuration and run `export PGSSLROOTCERT=~/supabase-ca.crt`. The scripts then connect with verify-full (certificate chain and host name). Without it they connect with an unverified certificate (`require`) and print a loud warning. [VERIFY] Check in the drill that the CA also validates the session pooler's certificate.
- **No secrets in output.** Scripts never print secret values. There are two exceptions:
  - the key and password files you ask for with `--out`. These must be **outside the repository**; the scripts refuse a path inside it. They are mode 600 and never overwritten.
  - `rotate-db-password.mjs --show`.

  If a rotation fails after its file was written, the script deletes the file only when it has confirmed that nothing was committed. If the commit landed anyway, or the check fails, the file is kept and the script says so.

**Records** go to the district evidence folder (`evidence/<yyyy-mm-dd>-<runbook>/`, outside this repository). They include times, counts, ids, `request_id`s, and who acted. They never include descriptions, photos, device data, or secrets.

---

## 3. An inappropriate item was approved

- **Trigger:** a published listing at `/s/<CODE>/items/<PUBLIC-ID>` shows something it must not. Typical sources are a student, parent, or staff report, a reviewer who notices it, or an `alert.severe_content` banner on `/district` when a late severe screening signal arrives after approval (G-24; the system then withdraws the item itself, and you continue from step 4).
- **Severity:** incident. Target: **15 minutes from the pull to verified deletion.** The district admin must be notified within 1 hour.
- **Owner:**
  - any staff member at the school (reviewer or above) pulls the item;
  - the school admin runs the rest;
  - the district admin is notified.
- **Steps:**
  1. **Start a timer and pull the item.** Open `/staff/<CODE>/items/<id>` from the queue or custody search, choose **Pull**, and select the reason `inappropriate`. In one transaction, `api_staff_item_pull`:
     - withdraws the publication;
     - writes a deletion ledger for every photo generation, and enqueues `delete_media` and `invalidate_cache`;
     - writes the `item.pull` audit row.
  2. **Break-glass, only if the staff app is down.** A district admin with the admin DB connection runs the same transaction by hand:

     ```sql
     select i.id, i.school_id, i.review_status, i.publication_status, i.custody
       from public.items i where i.public_id = 'FCHS-W-000214';          -- note the two uuids

     begin;
     update public.items set publication_status = 'withdrawn', withdrawn_at = now()
      where id = '<item uuid>' and publication_status in ('generating', 'published') and deleted_at is null;
     -- expect UPDATE 1; otherwise ROLLBACK and re-read the item
     select private.create_deletion_ledger('<item uuid>', '<school uuid>', 'pulled');
     select private.invalidate('<school uuid>', '<item uuid>');
     select private.audit('<school uuid>', 'system', 'runbook:break_glass', null, 'item.pull', 'items', '<item uuid>',
                          '{"publication_status": "published"}', '{"publication_status": "withdrawn"}',
                          '{"reason": "inappropriate"}');
     commit;
     ```

     `node scripts/switch.mjs --district posting=off --yes` stops new posts but does **not** hide an existing listing. Pull first.
  3. **Confirm the origin no longer serves it.** `curl -s -o /dev/null -w '%{http_code}\n' https://<web>/api/s/<CODE>/items/<PUBLIC-ID>` returns `404`, and the item is gone from `/s/<CODE>`.
  4. **Confirm deletion in the ledger.** The worker drains every minute.

     ```sql
     select l.id as ledger, l.reason, l.requested_at, l.verified_at,
            count(o.*) as objects, count(o.verified_at) as verified
       from public.media_deletion_ledger l join public.media_deletion_objects o on o.ledger_id = l.id
      where l.item_id = '<item uuid>' group by l.id order by l.id;
     ```

     If `verified_at` stays empty, run `node scripts/jobs.mjs --dead --kind delete_media` and follow runbook 13. A running drain is visible in `node scripts/jobs.mjs --summary`.
  5. **Check the exact public URLs.** Use no cache buster (G-27), so the CDN edge is tested:

     ```sql
     select o.object_kind, o.storage_path from public.media_deletion_objects o
       join public.media_deletion_ledger l on l.id = o.ledger_id
      where l.item_id = '<item uuid>' and o.object_kind in ('thumb', 'medium');
     ```

     `curl -s -o /dev/null -w '%{http_code}\n' "https://<project>.supabase.co/storage/v1/object/public/variants/<storage_path>"` must no longer return `200`. A browser that already loaded the image can keep it until its `Cache-Control` max-age; read it with `curl -sI` before deletion if possible, and record that bound.
  6. **Find out who approved it and when.**

     ```sql
     select a.created_at, a.action, a.actor_kind, a.actor_id as member_id, m.role, u.email
       from public.audit_log a
       left join public.staff_members m on m.id::text = a.actor_id
       left join public.staff_users u on u.id = m.user_id
      where a.target_table = 'items' and a.target_id = '<item uuid>'
      order by a.id;
     ```

  7. **Notify the district admin within 1 hour** through the district incident contact tree; Recover sends nothing. Use `evidence/templates/incident-3.md`. Include:
     - what was visible, and from when (`item.approve`) to when (`item.pull`);
     - who approved it;
     - when deletion was verified;
     - the browser cache bound.
  8. **If the poster should be stopped,** use **Block device** on the same item page (office and above, `api_staff_block_device`, reason `abuse`). The URL never carries the device digest.
  9. **If the content may be unlawful or concerns a student's safety,** follow the counsel-approved district incident path. Do not download, screenshot, or forward the image.
- **Verify:**
  - the listing is gone from `/s/<CODE>`;
  - every ledger row for the item has `verified_at`, and the exact variant URLs no longer return `200`;
  - the `item.approve` and `item.pull` rows are in `audit_log`;
  - the pull-to-verified time is under 15 minutes.
- **Record:** in the incident-3 note, record:
  - a timeline taken from `audit_log` and the ledger (approve, publish, pull, verified);
  - the approver's membership id;
  - the time the district was notified, and the minutes elapsed;
  - the browser-cache bound.

  For the quarterly rehearsal on staging, record the same timeline for the seeded "approved by mistake" item.

## 1. Queue backlog at a school

- **Trigger:** an `alert.queue_age` banner for the school (queue p95 over 24 hours) on `/district` or `/staff/<CODE>/stats`, or old pending cards at `/staff/<CODE>/queue`.
- **Severity:** school.
- **Owner:** the school admin; the district admin if it lasts more than 2 school days.
- **Steps:**
  1. Size the backlog:

     ```sql
     select s.code, count(*) as pending, round(extract(epoch from now() - min(i.created_at)) / 3600, 1) as oldest_hours
       from public.items i join public.schools s on s.id = i.school_id
      where i.review_status = 'pending' and i.deleted_at is null and i.custody in ('with_finder', 'at_location')
      group by s.code order by pending desc;
     ```

  2. **Rule out the worker.** Cards stuck in "processing" mean canonicalization or screening has stalled, not the reviewers. If `node scripts/jobs.mjs --summary` shows an old queue or dead jobs, follow runbook 13.
  3. **Who is notified:** nobody automatically. The district admin sees the alert on `/district`, and the school admin sees it on `/staff/<CODE>/stats`. The school admin contacts the reviewers directly.
  4. **Add reviewers.** Invite or reactivate them at `/staff/<CODE>/roster` with the role `reviewer`. A district admin can review any school's queue directly.
  5. **Clear spam runs with bulk reject.** At `/staff/<CODE>/queue`, select the cards and choose **Bulk reject** with the reason `spam` (`api_staff_bulk_reject`). Rejections feed device reputation and auto-block (G-12, G-34).
  6. **If a flood continues,** pause posting at the school: `node scripts/switch.mjs --school <CODE> student_posting=off --yes`. Switch it back on when the queue is clear.
- **Verify:** queue p95 is under 24 hours on `/staff/<CODE>/stats`, and no `alert.queue_age` for the school for a day.
- **Record:** the dates, the cause (volume, absence, or spam), the counts rejected, and any switch `request_id`s.

## 2. Screening provider outage

- **Trigger:** `alert.screening_error_rate` (over 5% in an hour) on `/district`; queue cards with the `screening_error` chip; or `node scripts/jobs.mjs --dead --kind screen_item` showing provider error codes.
- **Severity:** district.
- **Owner:** the district admin; district IT owns the Google Cloud project.
- **Steps:**
  1. **Confirm it is the provider.** `node scripts/jobs.mjs --dead --kind screen_item` groups failures by error code. Many items failing with a transient code (timeouts, 5xx) means an outage; check the Google Cloud status page. An authentication error means Workload Identity or OIDC configuration: escalate to district IT.
  2. **What staff see:** items arrive "screening pending" or with `screening_error`, sorted with the flagged items. Every item is still reviewed by a person.
  3. **What to tell staff:** "Automated photo screening is down. Review every photo yourself as usual. Nothing is published without your approval."
  4. **Students see no change.**
  5. **If the outage lasts more than 4 hours and the retries are noise,** turn screening off: `node scripts/switch.mjs --district screening=off --yes`. Items then stay `unscreened`, and staff posts publish without the advisory screen, so tell staff to check their own photos. Turn it back on after recovery.
  6. **After recovery,** replay the dead `screen_item` jobs: list them first with `jobs.mjs --dead --kind screen_item`, then run `node scripts/jobs.mjs --replay <id>`, check the plan, and repeat with `--yes` (E.3).
  7. **Escalate** to district IT if the outage lasts more than 4 hours, or at once if it is an authentication failure.
- **Verify:** new items show screening results, the error-rate alert clears, and no undisposed dead `screen_item` jobs remain.
- **Record:** the outage window, the number of items screened `error` in the window, and the switch and replay `request_id`s.

## 4. Suspected abuse pattern from one device or campus

- **Trigger:** `repeat_device` or `duplicate` chips in the queue; a spam run; an auto-block (`devices.block_reason = 'auto_rejections'`); a spike in `rate_limited` errors.
- **Severity:** school.
- **Owner:** the school admin. Office staff and above can block devices.
- **Steps:**
  1. **Block the device** from the item or report page with **Block device** (`api_staff_block_device`), giving a number of days and a reason. The server resolves the digest (F-85). Block each distinct poster.
  2. **Stop posting at the school while you review:** `node scripts/switch.mjs --school <CODE> student_posting=off --yes`.
  3. **Tighten limits.** v1 has no per-school limit override: the §13.2 limits are fixed inside `api_rate_take` (`0200_api_student.sql`). Changing them is a migration. Until then, turning posting off at the school is the lever. Campus IP ranges (`district_settings.campus_cidrs`) come from district IT.
  4. **Review the last 7 days:**

     ```sql
     select i.created_at::date as day, i.review_status, i.reject_reason, count(*)
       from public.items i join public.schools s on s.id = i.school_id
      where s.code = '<CODE>' and i.posted_by_kind = 'student' and i.created_at > now() - interval '7 days'
      group by 1, 2, 3 order by 1, 2, 3;
     select count(*) filter (where d.blocked_until > now()) as blocked_now, count(*) as devices_seen_7d
       from public.devices d join public.schools s on s.id = d.school_id
      where s.code = '<CODE>' and d.last_seen_at > now() - interval '7 days';
     ```

  5. **Clear what remains** with **Bulk reject** at `/staff/<CODE>/queue`, reason `spam`.
  6. **If the pattern is campus-wide,** meaning many devices, keep posting off and bring in the district admin and district IT.
  7. **Turn posting back on when it is clear:** `node scripts/switch.mjs --school <CODE> student_posting=on --yes`.
- **Verify:** the blocked device gets `403 device_blocked`, and the queue is back to its normal rate.
- **Record:** the block audit rows (`device.block`), the switch `request_id`s, and counts. Never record digests.

## 5. Staff offboarding

- **Trigger:** HR or district IT reports that a staff member has left or changed role.
- **Severity:** school.
- **Owner:** the school admin for school roles; a district admin for district admins.
- **Steps:**
  1. At `/staff/<CODE>/roster`, set the member to **deactivated** (`api_staff_roster_update`; step-up required, G-31). Repeat at every school where they have a membership:

     ```sql
     select coalesce(s.code, 'DISTRICT') as school, m.role, m.status, m.updated_at
       from public.staff_members m join public.staff_users u on u.id = m.user_id
       left join public.schools s on s.id = m.school_id
      where u.email = lower('<email>');
     ```

  2. District IT deprovisions the Google account, which alone blocks sign-in. Memberships are resolved on every request, so deactivation takes effect on the member's next request.
  3. **If the address will be reused for someone new:** the old Recover identity stays bound to the old Google `sub`, and the new person is denied until a district admin runs **Rebind identity** at `/district` (`api_district_identity_rebind`, audited).
- **Verify:** every membership shows `deactivated`, and the member's next request fails with `forbidden`.
- **Record:** the `staff.update` audit rows and the date.

## 6. School map replacement

- **Trigger:** a renovation or a wrong map.
- **Severity:** school.
- **Owner:** the school admin prepares it; the district admin activates it.
- **Steps:**
  1. At `/staff/<CODE>/map`, create a new draft (`api_staff_map_create_draft`) and upload the image. The worker canonicalizes it and records its dimensions.
  2. At `/staff/<CODE>/locations`, pin every active pickup location on the draft. Draw and name the zones (runbook 19 rules), then **Submit** (`api_staff_map_submit`). Zones freeze on submit (G-07).
  3. The district reviews the map (runbook 19) and activates it at `/district/maps`. The worker copies it to `maps`, and the previous version becomes `retired`.
  4. **Existing items keep their own version.** Each item stores its `map_version_id`: staff pins render on that version, and the public label is the zone name frozen with it.

     ```sql
     select v.id, v.approval_status, v.active, count(i.id) as items
       from public.map_versions v join public.schools s on s.id = v.school_id
       left join public.items i on i.map_version_id = v.id and i.deleted_at is null
      where s.code = '<CODE>' group by v.id order by v.created_at;
     ```

  5. Open a staff item posted before the switch and confirm that its pin renders on the retired map.
- **Verify:** new posts use the new version, old pins render, and `/s/<CODE>/found` shows the new map.
- **Record:** the old and new version ids, and the `map.submit` and `map.activate` audit rows.

## 7. End-of-term disposition day

- **Trigger:** the end of a term, or `/staff/<CODE>/custody` showing many items **disposition due** (set by `mark_disposition_due`).
- **Severity:** school.
- **Owner:** office staff; the school admin signs off.
- **Steps:**
  1. **Take the stats snapshot first:** `/staff/<CODE>/stats` for the term, printed to PDF.
  2. At `/staff/<CODE>/custody`, filter to disposition due, select the items, and choose **Bulk dispose** as `donated` or `disposed` (`api_staff_bulk_dispose`). Each item becomes terminal, its publication is withdrawn, and its photos enter the deletion ledger.
  3. **Watch the ledger drain:**

     ```sql
     select count(*) as ledgers, count(*) filter (where l.verified_at is null) as unverified,
            min(l.requested_at) filter (where l.verified_at is null) as oldest_unverified
       from public.media_deletion_ledger l join public.schools s on s.id = l.school_id
      where s.code = '<CODE>' and l.requested_at > now() - interval '1 day';
     ```

  4. If `delete_media` jobs die, follow runbook 13.
- **Verify:** no disposition-due items remain, `unverified` reaches 0 within the hour, and no `alert.deletion_unverified_*` banner appears.
- **Record:** the counts donated and disposed, and the stats PDF.

## 8. Key rotation

- **Trigger:** the scheduled rotation date in the credential inventory, a departing owner, or a suspected leak. For a leak, go to runbook 16, 17, or 22 first.
- **Severity:** district.
- **Owner:** the district admin, under the two-owner rule.
- **Steps:** each credential rotates on its own.
  1. **Web and worker DB passwords (O-20).**
     1. `node scripts/rotate-db-password.mjs --role recover_web --out ~/recover_web.pw`. Read the plan, then repeat with `--yes`. The script sends a SCRAM verifier, so the plaintext never reaches the server.
     2. Build `postgresql://recover_web.<ref>:<password>@<pooler-host>:6543/postgres` and set it as `DATABASE_URL` in `recover-web` (`vercel env rm` / `vercel env add ... production`).
     3. Redeploy right away: new connections fail until then.
     4. Repeat for `--role recover_worker` and the `recover-worker` project.
  2. **Storage S3 key (worker only, D-16).**
     1. In Supabase, go to Dashboard > Storage > S3 Connection and create a new access key.
     2. Set `SUPABASE_S3_ACCESS_KEY_ID` and `SUPABASE_S3_SECRET_ACCESS_KEY` in `recover-worker` only, then redeploy.
     3. Check the new key with `node scripts/reconcile-orphans.mjs`, which only lists.
     4. Revoke the old key.
  3. **Scheduler bearer.** The bearer itself is never printed.
     1. Generate it into a new mode-600 file outside the repository. Only its SHA-256 is printed:

        ```bash
        node -e "const c=require('crypto'),fs=require('fs');const b=c.randomBytes(32).toString('base64url');fs.writeFileSync(process.argv[1],b,{mode:0o600,flag:'wx'});console.log('SCHEDULER_BEARER_SHA256='+c.createHash('sha256').update(b).digest('hex'))" ~/scheduler-bearer.txt
        ```

     2. Store it in Vault straight from the file, so it never appears on screen or in shell history. psql reads the file into a variable:

        ```
        \set bearer `cat ~/scheduler-bearer.txt`
        select vault.update_secret((select id from vault.secrets where name = 'scheduler_bearer'), :'bearer');
        ```

     3. Set `SCHEDULER_BEARER_SHA256` in `recover-worker` to the printed hash, and redeploy.
     4. Drains return 401 between the two changes, which is harmless because the next minute retries.
     5. Copy the bearer from the file into the password manager (the fallback scheduler in runbook 20 needs it), then delete the file with `rm -P`.
  4. **Staff-assertion key:** runbook 17.
  5. **Device key:** runbook 21.
  6. **Internal secrets.**
     - `REVALIDATE_SECRET` (worker) with `REVALIDATE_SECRET_SHA256` (web): set both, then redeploy both.
     - The readiness bearer with `READY_SECRET_SHA256` (web): same procedure.
  7. **`AUTH_SECRET` (web):** rotating it signs every staff member out.
  8. **Nothing to rotate** for Google Vision (OIDC federation, no JSON key) or web to worker (Vercel OIDC). No Supabase signing key is held by any runtime (§7.5).
- **Verify:**
  - `/s/<CODE>` and `/staff` work;
  - `node scripts/jobs.mjs --summary` shows a heartbeat under 2 minutes old;
  - `select status_code from net._http_response order by created desc limit 3;` shows `200`s after the bearer change;
  - Vercel logs are free of authentication failures.
- **Record:** the credential inventory: name, owner, and rotation date, never values, plus the script `request_id`s. Delete the `--out` files with `rm -P` (macOS) or `shred -u` (Linux).

## 9. Restore from backup

- **Trigger:** data loss or corruption that needs a database restore, and each quarterly restore drill.
- **Severity:** incident.
- **Owner:** the district admin together with district IT, who own the Supabase organization.
- **Steps:**
  1. **Choose the topology before touching anything [VERIFY in the drill]:**
     - **In place:** pooler hostnames, the S3 endpoint, and Vault stay the same.
     - **New project:** `DATABASE_URL`s, S3 endpoint and keys, and Vault secrets must be recreated (`docs/DEPLOY.md`), and reads switch over at the checkpoint by changing the web `DATABASE_URL`.
  2. **Pause the scheduler first (G-06).** The restored `pg_cron` schedule and Vault bearer come back with the data and would drive the worker within a minute. In `recover-worker`, set `SCHEDULER_BEARER_SHA256` to 64 zeros and redeploy, so every scheduled drain returns 401.
  3. **Restore** at Supabase Dashboard > Database > Backups. The RTO objective is 4 hours or less, until a drill measures it.
  4. **Immediately** run `node scripts/restore-quarantine.mjs --begin --yes`, then continue with runbook 12. This:
     - disables every pg_cron job;
     - sets `worker_mode = quarantine` and turns the three global switches off;
     - queues the expiry jobs;
     - writes one audit row (`runbook.restore_quarantine`, phase begin) that also records the audit gap.
  5. **What is lost (RPO 24 hours, §16.1):** database changes since the backup. That means posts, reviews, custody changes, lost reports, device blocks, and identity rebinds, plus audit rows (the gap is recorded as a row). Media is never recreated:
     - objects deleted after the backup stay deleted, and rows that still point at them are reconciled;
     - objects uploaded after the backup become orphans.
- **Verify:** as in runbook 12.
- **Record:** the restore drill report: the backup time against the incident time (actual RPO), start to reopen (actual RTO), the begin row's `request_id` (it carries the audit gap), and the orphan and missing counts from runbook 12.

## 10. Adding a school

- **Trigger:** a school joins (§24).
- **Severity:** school.
- **Owner:** the district admin creates the school; the school admin does the rest.
- **Steps:**
  1. **Create the school** at `/district/schools` with its code, name, time zone, and first school admin (`api_district_school_create`). Track progress on the onboarding checklist at `/district` (`api_district_onboarding`).
  2. **Load at least 90 days of calendar.** Export `day,is_open,open_at,close_at` from the district calendar, then run `node scripts/calendar-horizon.mjs --school <CODE> --extend calendar.csv`, check the plan, and repeat with `--yes`. `node scripts/calendar-horizon.mjs --school <CODE>` must report 90 days or more.
  3. **Map, locations, and zones:** runbook 6, steps 1-3, and runbook 19.
  4. **Roster:** invite staff at `/staff/<CODE>/roster`. Recover sends no email; pass the sign-in link on yourself.
  5. **Backfill the shelf** at `/staff/<CODE>/post?mode=backfill`.
  6. **Print QR posters:** `node scripts/qr-posters.mjs --school <CODE> --halls A,B,gym,cafeteria --base https://<web domain>`, then repeat with `--yes`. Print `posters/<CODE>/*.svg` and keep that folder out of git.
  7. **Synonyms (optional):** after editing `packages/shared/src/synonyms.json`, run `node scripts/load-synonyms.mjs`, then repeat with `--yes`.
  8. **Keep student posting off for 2 weeks.** New schools default to off. Check with `node scripts/switch.mjs --school <CODE>`.
  9. **Turn student posting on** once the district screening evaluation has passed (§22): at `/staff/<CODE>/config`, or with `node scripts/switch.mjs --school <CODE> student_posting=on --yes`.
  10. **Week-4 review:** `/staff/<CODE>/stats` (recovery, queue age, rejections, zero-result searches); tune synonyms.
- **Verify:** the onboarding checklist at `/district` is complete, `/s/<CODE>` shows the backfilled feed, and a poster scans to the right URL.
- **Record:** the onboarding evidence (`evidence/onboarding/<CODE>/`), the calendar and poster `request_id`s, and the time spent.

## 11. Sunset / read-only mode

- **Trigger:** the end of the pilot, the sunset date, or a district decision to pause.
- **Severity:** district.
- **Owner:** the district admin.
- **Steps:**
  1. Run `node scripts/switch.mjs --district posting=off lost_reports=off cross_school=off --yes`. The feed stays readable: published items remain until they are claimed, disposed, or expired, and staff custody work continues.
  2. Stop printing posters, and tell the schools.
  3. Keep the worker running, so that expiry, retention, and deletion jobs keep emptying the data on schedule.
  4. **To retire completely:**
     1. wait until `select count(*) from public.items where publication_status = 'published';` is 0 and no ledger is unverified;
     2. export the district stats;
     3. delete the projects under the district data-retention decision.
- **Verify:** `/api/s/<CODE>/meta` reports every flag false, and a post attempt returns `403 feature_disabled`.
- **Record:** the switch `request_id`, the date, and the decision reference.

## 12. Restore quarantine

- **Trigger:** runbook 9 step 4, and every restore drill.
- **Severity:** incident.
- **Owner:** the district admin. Two owners sign the checkpoint.
- **Steps:** these are §16.5 steps 2-8.
  1. **Begin.** Run `node scripts/restore-quarantine.mjs --begin` to read the plan, then repeat with `--yes`. Pass `--restored-at <ISO time>` when the restore finished earlier than now. The script:
     - disables every pg_cron job with `cron.alter_job`;
     - sets `worker_mode = quarantine`, so only `reconcile_generating` and `reconcile_orphan_uploads` lease;
     - turns the three global switches off;
     - queues `expire_never_arrived`, `mark_disposition_due`, and `expire_reports`, which run at reopen;
     - writes exactly one audit row, `runbook.restore_quarantine` with phase begin. Its metadata records the audit gap (the last audit id and its time, and the restore time), the cron jobs it disabled, and the switches it turned off;
     - prints the roster checklist.

     Running `--begin` a second time is safe: `--reopen` restores every job disabled by any `--begin` since the last reopen.
  2. **Roster (§16.5 step 3).**
     1. Get the directory export from district IT and run `node scripts/restore-quarantine.mjs --directory export.csv`. It lists every live membership whose email is missing from the export.
     2. Deactivate each of them (runbook 5).
     3. Repeat any identity rebind made after the backup.
  3. **Suppressions.** Device blocks added after the backup are gone. Re-block repeat devices as they reappear (runbook 4).
  4. **Media (§16.5 step 6).** Reconcile twice.
     1. **Right after `--begin`,** run `node scripts/reconcile-orphans.mjs --min-age-hours 1` (a dry run). The default 24-hour minimum age would hide objects uploaded after the backup when the restore happens within a day of them.
     2. **Again 24 hours later,** run it with the default age. This catches uploads that were in flight during the restore.

     Each run covers `incoming`, `originals`, `variants`, `map_drafts`, and `maps`:
     - **Missing objects** are rows that point at deleted objects. Pull every published item whose variants are missing (runbook 3 step 1, or its break-glass SQL). An approved map with a missing public object needs a new version (runbooks 6 and 19). Never re-upload.
     - **Orphans** are objects uploaded after the backup. Delete them by repeating the same command with `--yes` after review.
  5. **Reads.** There is no read switch.
     - **In-place restore:** the feed serves the restored rows at once, so do step 4 first. Items claimed after the backup may reappear; staff re-claim them.
     - **New project:** reads switch over here, by pointing the web `DATABASE_URL` at the restored project.
  6. **Tenancy and privileges (§16.5 step 7):** `DB_URL=<restored admin URL> npm run test:sql` must pass. It covers the privilege diff, tenant property, and constraint suites.
  7. **Checkpoint (§16.5 step 8).**
     1. Run `node scripts/restore-quarantine.mjs` with no flags. Every pg_cron job must still be inactive, because a migration can reschedule them.
     2. Two owners sign the checkpoint note.
  8. **Reopen.**
     1. Run `node scripts/restore-quarantine.mjs --reopen --yes`. This re-enables every cron job disabled by a `--begin` since the last reopen, matched by name or id, and sets `worker_mode = normal`. The queued expiry work runs on the next drain.
     2. Restore the real `SCHEDULER_BEARER_SHA256` in `recover-worker` and redeploy (runbook 9 step 2).
  9. **Posting last.** Once `node scripts/jobs.mjs --summary` shows the expiry jobs done, run `node scripts/switch.mjs --district posting=on lost_reports=on cross_school=on --yes`.
- **Verify:**
  - `jobs.mjs --summary` shows `worker_mode=normal`, a fresh heartbeat, and no backlog;
  - `restore-quarantine.mjs` shows every cron job active;
  - `reconcile-orphans.mjs` reports no missing objects on published items;
  - the SQL suite is green.
- **Record:** the begin and reopen `request_id`s (the begin row carries the audit gap), the roster changes, the orphan and missing counts from both reconcile runs, the SQL suite result, the checkpoint signatures, and the times (the drill report's RTO).

## 13. Worker stuck / dead-letter

- **Trigger:** `alert.oldest_job` (a queued job older than 10 minutes), `alert.dead_jobs`, or `alert.worker_stale` on `/district`; items stuck in `generating`; `api_health()` showing `deadJobs > 0`.
- **Severity:** district.
- **Owner:** the maintainer on duty, with the district admin informed.
- **Steps:**
  1. Run `node scripts/jobs.mjs --summary` to see counts per kind, the oldest due age, the worker mode, and the last heartbeat.
  2. **If the heartbeat is stale,** nobody is invoking the worker:

     ```sql
     select j.jobname, d.status, d.return_message, d.start_time
       from cron.job_run_details d join cron.job j using (jobid)
      order by d.start_time desc limit 10;
     select id, status_code, timed_out, error_msg, created from net._http_response order by created desc limit 10;
     ```

     - Failing pg_cron or pg_net calls: runbook 20.
     - `401`s: the bearer hash (runbook 8) or deployment protection (O-24).
     - `5xx`s: check the `recover-worker` deployment logs and roll back the deployment.
  3. **Inspect leases** with `node scripts/jobs.mjs --running`. Expired leases are requeued, or dead-lettered at max attempts, by `system_reap_leases` at the start of every drain.
  4. **Tell an outage from poison.** Run `node scripts/jobs.mjs --dead`, which groups by kind and error code:
     - **Outage:** many jobs of one kind, one transient code, many payloads. Fix or wait, then replay.
     - **Poison:** one payload with a permanent code (for example `decode_failed`). Do not replay it. Dispose it and fix the item, for example by dropping the photo at `/staff/<CODE>/items/<id>` (G-23).
  5. **Replay after the fix:**
     1. Run `node scripts/jobs.mjs --replay <id>`. The plan shows a new dedupe key, `<old>:replay:<utc>`.
     2. Repeat with `--yes`.
     3. Jobs are idempotent, so a replay is safe.
     4. For bulk replays, list first to get the preview count, and replay one school's jobs at a time (E.3).
  6. **Close out** handled jobs with `node scripts/jobs.mjs --dispose <id> --yes`. This starts the 90-day retention clock.
  7. **If `worker_mode=quarantine` shows,** only reconciliation kinds lease. Either the quarantine is intended (runbook 12), or run `node scripts/switch.mjs --district worker_mode=normal --yes`.
- **Verify:** no undisposed dead jobs, the oldest queued job is under 10 minutes, and `generating` items publish.
- **Record:** the replayed and disposed job ids (`runbook.jobs_*` rows), and the root cause.

## 14. Screening ceiling reached

- **Trigger:** an `alert.screening_budget` banner (over 80% of `screening_daily_ceiling`), or queue items flagged `ceiling`.
- **Severity:** district.
- **Owner:** the district admin.
- **Steps:**
  1. **Is it volume or abuse?**

     ```sql
     select c.count as images_today, d.screening_daily_ceiling as ceiling
       from public.district_settings d
       left join public.rate_counters c on c.tenant_scope = 'district' and c.action = 'screening'
            and c.window_start = date_trunc('day', now(), 'UTC')
      where d.id = 1;
     select s.code, count(*) as posts_24h from public.items i join public.schools s on s.id = i.school_id
      where i.created_at > now() - interval '24 hours' and i.posted_by_kind = 'student'
      group by s.code order by 2 desc;
     ```

     One school or device far above normal means abuse: follow runbook 4.
  2. **If it is real volume,** raise the ceiling deliberately at `/district/settings`, which is audited as `district.config`. Check the Google Cloud budget alert, which is the second fence.
  3. **Review ceiling items first.** They are sorted with the flagged items, but have no screening signals at all.
- **Verify:** new items have screening results again; the next day passes without `alert.screening_budget`.
- **Record:** the old and new ceiling, the reason, and the daily counts.

## 15. Privacy / deletion request

- **Trigger:** a student or parent asks for the student's posts or lost reports to be deleted.
- **Severity:** school.
- **Owner:** the school admin, who can have office staff act. The district admin files the processor request.
- **Steps:**
  1. **Identify the records on the student's own device.** At the office, the student opens `/s/<CODE>/mine` and `/s/<CODE>/lost/mine` and points at them. Staff note the item IDs and which reports they are. There is deliberately no digest lookup.
  2. **Lost reports:** the student can close them on the device, or staff close them at `/staff/<CODE>/reports` with **Close** (`closed_by_staff`). Content is cleared 30 days after closing (`purge_closed_reports`).
  3. **Posts:** at `/staff/<CODE>/items/<id>`, choose **Delete** (office and above, `api_staff_item_delete`), or **Pull** with the reason `owner_request` for a live listing. Publication is withdrawn, the photos enter the deletion ledger, and the text is cleared after `terminal_text_retention_days`.
  4. **If a photo was screened,** the district admin files the Google Cloud deletion request under the processor terms (O-15) and records the ticket id. To check:

     ```sql
     select count(*) from public.screening_runs where item_id = '<item uuid>';
     ```

  5. **Include the backup caveat** in the written reply: copies inside provider backups expire under the provider's backup retention.
- **Verify:** the listings are gone, the ledger rows for the items have `verified_at` (runbook 3 step 4 query), and the reports are closed.
- **Record:** the request date, the item and report ids (never device data), the completion date, and the processor ticket id.

## 16. Suspected tenant isolation defect

- **Trigger:** staff see another school's data, a `tenant_property.sql` failure, or a report of a cross-school reference.
- **Severity:** incident.
- **Owner:** the district admin together with district IT and counsel.
- **Steps:**
  1. **Kill global writes:** `node scripts/switch.mjs --district posting=off lost_reports=off cross_school=off --yes`.
  2. **If staff paths are involved,** revoke every staff assertion with `node scripts/rotate-assertion-key.mjs --emergency --yes`. Every staff and district call then fails closed until a new key is deployed (runbook 17).
  3. **Preserve the audit log.** It is append-only by trigger. Export the window:

     ```
     \copy (select id, school_id, actor_kind, actor_id, request_id, action, target_table, target_id, state_before, state_after, metadata, created_at from public.audit_log where created_at >= '<start>') to 'audit-<date>.csv' csv header
     ```

  4. **Scope the exposure:** which functions, which schools, which rows, and what time window, taken from the audit rows by actor and school. Keep the analysis in the evidence folder.
  5. **Rotate credentials if needed:** the DB passwords (runbook 8), the assertion key (17), and S3 (22).
  6. **Follow the district incident path** with counsel and IT, including any notification duty.
  7. **Fix forward:** a migration plus a regression case in `supabase/tests/tenant_property.sql`, with `npm run test:sql` green. Re-enable the switches only after sign-off.
- **Verify:** the tenant property suite is green on the fix, and the switches are back on only with sign-off.
- **Record:** the timeline, the scope, the notifications, the fix PR, and the switch and rotation `request_id`s.

## 17. Staff-assertion key rotation / emergency revocation

- **Trigger:** a scheduled rotation, a departing owner, or a suspected leak of `STAFF_ASSERTION_KEY_CURRENT`. The staging rehearsal is a Phase 0 gate (O-23).
- **Severity:** district for a rotation; incident for a revocation.
- **Owner:** the district admin, who holds the web project and the admin DB access.
- **Steps (routine rotation):**
  1. Run `node scripts/rotate-assertion-key.mjs` to show the pointers (`current`, `previous`) and the stored versions.
  2. Run `node scripts/rotate-assertion-key.mjs --next --out ~/assertion-v<N+1>.env`, check the plan, and repeat with `--yes`. This:
     - creates `staff_assertion_key_v(N+1)` in Vault;
     - sets `current = N+1` and `previous = N`, so both versions verify;
     - writes the file in mode 600.
  3. Set `STAFF_ASSERTION_KEY_CURRENT` and `STAFF_ASSERTION_KEY_VERSION` in `recover-web` production from the file, and redeploy.
  4. Wait until the new deployment serves traffic, **plus 60 seconds** (one 30-second assertion lifetime plus clock skew).
  5. Run `node scripts/rotate-assertion-key.mjs --finish --yes`, which clears `previous`. The script refuses to run within 60 seconds of `--next`.
  6. Delete the key file (`rm -P`).
- **Steps (emergency revocation):**
  1. Run `node scripts/rotate-assertion-key.mjs --emergency --yes`, which clears both pointers. Every staff request now fails `assertion_invalid`, closed.
  2. Immediately run `--next --out <file> --yes`. It creates v(max+1) with `previous` empty, so the revoked key never verifies again.
  3. Set the web env and redeploy. Staff are locked out for one deploy cycle.
- **Verify:** a staff action (approve or receive) succeeds after the deploy. Before `--finish`, both versions verify; after it, only `current` does. `node scripts/rotate-assertion-key.mjs` prints the pointers, or query them directly. The pointers hold version numbers, not keys; never select `decrypted_secret` for a `staff_assertion_key_v<n>` row.

  ```sql
  select name, btrim(decrypted_secret) as version from vault.decrypted_secrets
   where name in ('staff_assertion_key_current', 'staff_assertion_key_previous') order by name;
  select name from vault.secrets where name ~ '^staff_assertion_key_v[0-9]+$' order by name;  -- stored versions, names only
  ```

- **Record:** the old and new version numbers, the times, and the `request_id`s. Never record the key.

## 18. Orphan storage reconciliation

- **Trigger:** monthly; after a restore (runbook 12) or a storage incident (runbook 22); unexplained storage growth.
- **Severity:** district.
- **Owner:** the district admin, on a machine allowed to hold the worker S3 key.
- **Steps:**
  1. Run `node scripts/reconcile-orphans.mjs`, which is a dry run. S3 settings come from `--worker-env <file>`, else the exported `SUPABASE_S3_*` variables, else `apps/worker/.env.local`. The key must never go into `recover-web`. The script lists `incoming`, `originals`, `variants`, `map_drafts`, and `maps`, and compares every key with `item_photos`, `map_versions`, and the unverified deletion ledger. It classifies each object as:
     - `referenced`, `pending_deletion`;
     - `no_row` or `unreferenced` (the two orphan classes);
     - `too_new` (younger than `--min-age-hours`, default 24);
     - `unrecognized` (never deleted);
     - `missing` (a DB path with no object).
  2. Review the orphans. Public object tokens (variants and maps) are masked; `--show-keys` shows them in full.
  3. Delete them with `--yes`, capped by `--max-delete` (default 500). Immediately before each `DELETE`:
     - the key is looked up in the database again and must still be an orphan;
     - a `HEAD` must show the same object the listing saw (same ETag).

     Anything else is skipped and counted. The audit row is written even when the run fails or is interrupted with Ctrl-C.
  4. **Missing objects are never recreated.** Pull published items whose variants are missing (runbook 3). An approved map with a missing public object needs a new version (runbooks 6 and 19). Leave the rest to the retention jobs.
- **Verify:** a second dry run reports no orphans older than the minimum age.
- **Record:** the counts per bucket and class, including the skipped counts and whether the run was interrupted or aborted (the `runbook.reconcile_orphans` row carries them), and the `request_id`.

## 19. Public map review

- **Trigger:** a map version in `pending_district` at `/district/maps`.
- **Severity:** district.
- **Owner:** the district admin with the district safety or IT reviewer.
- **Steps:**
  1. Open the canonical draft at `/district/maps`. It is streamed through a `map.read` ticket and is never public.
  2. **The map must be simplified and public-safe:** no internal floor-plan detail, room numbers of sensitive areas, cameras, access-control points, or emergency-procedure markings.
  3. **Every zone name is public.** Reject restrooms, the clinic or nurse, counseling, special-program rooms, and security areas. Zones freeze on submit (G-07), so ask for changes with **Reject** and a reason (`api_district_map_reject`).
  4. **Activation needs** every active pickup location pinned and at least one zone (§24 step 3).
  5. **Activate** at `/district/maps`. The worker copies the approved image to `maps`, and the previous version becomes `retired`.
- **Verify:** `/s/<CODE>/found` shows the new map, and the version is `approved` and `active`.
- **Record:** the reviewers' names (in the evidence folder, not in audit), the version id, and the `map.activate` row.

## 20. Worker scheduler fallback

- **Trigger:** `alert.worker_stale` or `alert.health_gap`, failing rows in `cron.job_run_details`, or errors in `net._http_response`. Drill it once a term.
- **Severity:** district.
- **Owner:** the district admin with the maintainer.
- **Steps:**
  1. **Find which half is failing.** `select jobid, jobname, schedule, active from cron.job order by jobid;` then use the two queries in runbook 13 step 2.
     - `recover_drain` is the one-minute HTTP call (`private.cron_drain()`, through pg_net).
     - The other jobs are SQL enqueues (`private.enqueue_periodic`) and need no pg_net.
  2. **If pg_net fails but pg_cron runs,** switch only the drain to an external scheduler:
     1. Disable the drain: `select cron.alter_job((select jobid from cron.job where jobname = 'recover_drain'), active := false);`
     2. On a district-controlled host, add a crontab entry. The bearer comes from the password manager and is the same value as the Vault `scheduler_bearer`:

        ```
        * * * * * curl -fsS -m 55 -X POST -H "Authorization: Bearer $SCHEDULER_BEARER" https://<recover-worker>/api/jobs/run >/dev/null
        ```

     3. Vercel Cron is not a drop-in replacement, because it only sends GET. `scripts/dev.mjs` does the same POST locally.
  3. **If pg_cron itself is down,** the periodic enqueues stop too, including the 5-minute health check. Until it is back, enqueue the maintenance jobs from the same district host with `node scripts/jobs.mjs --enqueue <kind> --yes`, on the pg_cron cadence:

     | Cadence | Kinds |
     |---|---|
     | every 5 minutes | `evaluate_alerts` |
     | every 15 minutes | `expire_never_arrived`, `expire_reports`, `reconcile_generating` |
     | hourly | `mark_disposition_due`, `purge_drafts`, `reconcile_orphan_uploads` |
     | nightly (07:15 UTC) | `anonymize_rejected`, `clear_terminal_item_text` |

     **Crontab note.** The host needs the admin `DB_URL` and `PGSSLROOTCERT` for as long as this runs.
     - Keep them in a mode-600 file readable only by the account that runs cron, for example `~/.recover-ops.env` containing `export DB_URL=...` and `export PGSSLROOTCERT=...`.
     - Delete the file as soon as pg_cron is back.

     With a checkout in `/opt/recover`:

     ```
     */5 * * * *  . ~/.recover-ops.env && cd /opt/recover && node scripts/jobs.mjs --enqueue evaluate_alerts --yes >/dev/null
     */15 * * * * . ~/.recover-ops.env && cd /opt/recover && for k in expire_never_arrived expire_reports reconcile_generating; do node scripts/jobs.mjs --enqueue $k --yes; done >/dev/null
     0 * * * *    . ~/.recover-ops.env && cd /opt/recover && for k in mark_disposition_due purge_drafts reconcile_orphan_uploads; do node scripts/jobs.mjs --enqueue $k --yes; done >/dev/null
     15 7 * * *   . ~/.recover-ops.env && cd /opt/recover && for k in anonymize_rejected clear_terminal_item_text; do node scripts/jobs.mjs --enqueue $k --yes; done >/dev/null
     ```

     Each enqueue writes one `runbook.jobs_enqueue` audit row, and an enqueue that pg_cron already made in the same minute is skipped. `rollup_daily_stats` and the purges need payloads, so they wait for pg_cron.
  4. **Switch back:** `select cron.alter_job((select jobid from cron.job where jobname = 'recover_drain'), active := true);`, then remove the external crontab entries and delete `~/.recover-ops.env`.
- **Verify:** `node scripts/jobs.mjs --summary` shows a heartbeat under 2 minutes old and the oldest due job under 10 minutes; `health_checks` has no gap.
- **Record:** the window, the fallback used, and the switch-back time.

## 21. Device-key rotation

- **Trigger:** a scheduled rotation, or a suspected leak of `DEVICE_KEY_V1`.
- **Severity:** district.
- **Owner:** the district admin with the maintainer.
- **Current limit:** `apps/web/lib/device.ts` derives digests with `DEVICE_KEY_V1` only (version byte 1). The dual-derivation window in `13-Abuse-and-Rate-Limiting.md` is **not implemented yet**. A planned rotation needs that web change first: derive with both keys, match either, write with the new one.
- **Steps:**
  1. **Assess the risk.** A leaked device key alone does not expose students. Reading a report or item status also needs that device's HttpOnly cookie token, and digests are school-scoped HMACs. A planned rotation can therefore wait for the dual-derivation change.
  2. **Once dual derivation exists:**
     1. Add `DEVICE_KEY_V2` to `recover-web` and deploy.
     2. Keep V1 for `lost_report_ttl_days` (60 days), so open reports stay reachable.
     3. Remove V1 and redeploy.
  3. **If a rotation cannot wait,** replace `DEVICE_KEY_V1` and redeploy, knowingly:
     - every open lost report becomes unreachable from its device (the accepted risk F-66: staff still see the reports, and students can file again);
     - device reputation and blocks restart.
- **Verify:** a lost report filed before the rotation is still listed at `/s/<CODE>/lost/mine` on the same browser. With the forced path, confirm that new posts and reports work.
- **Record:** the date, the path taken, and the count of open reports affected:

  ```sql
  select count(*) from public.lost_reports where status = 'open';
  ```

## 22. Storage-root credential incident

- **Trigger:** a suspected leak of the worker S3 key, for example from a log, a misconfigured environment, or a repository scan.
- **Severity:** incident.
- **Owner:** the district admin with district IT.
- **Steps:**
  1. **Stop posting and media work:** `node scripts/switch.mjs --district posting=off lost_reports=off worker_mode=quarantine --yes`. In quarantine, only the reconciliation kinds lease.
  2. **Rotate the key.** At Dashboard > Storage > S3 Connection, revoke the leaked key and create a new one. Set `SUPABASE_S3_*` in `recover-worker` only, and redeploy.
  3. **Reconcile every bucket, and list everything written during the exposure window.** Use the new key and run `node scripts/reconcile-orphans.mjs --since <exposure start, ISO time>` (a dry run). It covers `incoming`, `originals`, `variants`, `map_drafts`, and `maps`. Besides the usual classes, it lists **every** object modified since that time, whether referenced or not, next to the time its database row last changed. Keep the list in the evidence folder, then:
     - **Overwritten live objects.** A referenced object flagged `written after its row` changed long after the database last touched it, so treat it as overwritten:
       - for a variant, pull the item (runbook 3) and repost it through staff;
       - for a public map, have a clean version reviewed and activated (runbooks 6 and 19);
       - for an original or a draft, reprocess it from a trusted source, or drop the photo.
     - **Unexpected writes.** Review orphans and `unrecognized` keys written in the window as attacker candidates. Delete orphans with `--yes` after review.
     - **Missing objects.** Pull published items whose objects are missing.
  4. **Review worker logs** in Vercel for the exposure window.
  5. **Prove the web never held the key:**
     - `vercel env ls production` in `recover-web` lists no `SUPABASE_S3_*` names;
     - `node scripts/repo-audit.mjs` passes;
     - `git log -p -S SUPABASE_S3_SECRET_ACCESS_KEY -- apps/web` shows nothing.
  6. **Return in order:**
     1. `node scripts/switch.mjs --district worker_mode=normal --yes`;
     2. check `jobs.mjs --summary`;
     3. `node scripts/switch.mjs --district posting=on lost_reports=on --yes`.
- **Verify:**
  - the old key is rejected;
  - the `--since` list has every object explained, or pulled and replaced;
  - the web environment is clean;
  - the queue drains in normal mode.
- **Record:** the timeline, the key rotation time, the exposure window, the `--since` list with its dispositions, the reconciliation counts, and the evidence of the web environment check.

## 23. Calendar horizon

- **Trigger:** an `alert.calendar_horizon` banner for a school, `api_health()` showing a low `calendarHorizonD`, or `node scripts/calendar-horizon.mjs` exiting 1. Coverage must never fall below 45 days (F-88).
- **Severity:** school.
- **Owner:** the district admin, with the school admin supplying the dates.
- **Steps:**
  1. Run `node scripts/calendar-horizon.mjs` for every active school. For each school it shows:
     - today (school-local) and the horizon: consecutive covered days from tomorrow, where the first gap ends coverage;
     - the covered-through date, the open days, and the status.
  2. Export the next term from the district calendar as CSV with the header `day,is_open,open_at,close_at` (for example `2027-01-04,true,07:30,16:30` and `2027-01-18,false,,`).
  3. Run `node scripts/calendar-horizon.mjs --school <CODE> --extend next-term.csv`. The plan shows the days added and changed and the horizon before and after. Repeat with `--yes`.
     - Changing a day that already exists needs `--allow-changes`.
     - Open arrival deadlines are recomputed in the same transaction by the calendar trigger (`0011_calendar_recompute.sql`, G-01).
- **Verify:** the horizon is 45 days or more (90 or more for a school in onboarding), and the alert clears after the next health check.
- **Record:** the `runbook.calendar_extend` `request_id` and the new covered-through date.

## 24. Audit privacy review

- **Trigger:** quarterly, and after any migration that adds or changes an audit writer.
- **Severity:** district.
- **Owner:** the district admin.
- **Steps:**
  1. Run `node scripts/audit-privacy-sample.mjs --sample 1000` (the newest rows) and `node scripts/audit-privacy-sample.mjs --random --sample 1000`. The script checks every key and value in `state_before`, `state_after`, and `metadata`, and `actor_id` and `target_id`, against these rules:
     - forbidden key names: description, note, pin, email, digest, path, token, and similar;
     - keys **and** values with an `@`;
     - storage-path-like keys and values (`<uuid>/<uuid>/...`);
     - 64-hex digests;
     - free text of three or more words.

     A finding names the row, action, place, and rule, never the value. A key is shown only when it is a plain identifier that breaks no rule; any other key appears as `<key n redacted>`, n being its position in the object. A key violation is reported as `key_<rule>`. The script exits 1 on FAIL.
  2. **On PASS,** record the result with `--yes`, which writes `runbook.audit_privacy_sample` with the counts.
  3. **On FAIL:**
     1. fix the writer (`private.audit_guard`, `packages/shared/src/audit.ts`, or the function that wrote the row) and add a test;
     2. the retained rows can only be removed by an approved retention migration, because `audit_log` is append-only;
     3. record both.
- **Verify:** both samples PASS after the fix.
- **Record:** the result row `request_id`, the sample sizes, and any findings with the fix PR.

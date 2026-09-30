# Deploying Recover

This guide takes Recover from a clean checkout to a staging or production deployment, in this order: one Supabase project, two Vercel projects (`recover-web` and `recover-worker`), and one Google Cloud project.

Every account is district-owned with two named owners (§27, doctrine 11). The student maintainer is a member, never the sole owner.

> Production posting stays **off** until the Appendix J evidence is complete (§0.3). Deploying the software is not the same as enabling student posting.

## 0. Prerequisites

- **CLIs:** Supabase CLI (`supabase login`), Vercel CLI (`vercel login`), `psql`, and Node 22.18+.
- **Secrets:** generate every secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Store them in the district password manager and in the provider settings named below, never in the repository.

## 1. Supabase (database, Storage, Vault, cron)

**1. Create the project** in the district organization. Use Pro for production (spend cap on) and Postgres 15 or newer.

**2. Link and push the migrations.** `supabase/seed.sql` is local-only and is not pushed.

```bash
supabase link --project-ref <ref>
supabase db push
```

**3. Set the two login passwords** over a direct connection as the `postgres` admin:

```sql
alter role recover_web    password '<32-byte random>';
alter role recover_worker password '<32-byte random>';
```

**4. Load the district settings and the first district admin** with `supabase/bootstrap.example.sql`. Copy it, fill in the placeholders, and run it once with `psql`.

**5. Create the Vault secrets.** Use the SQL editor or `psql`:

```sql
select vault.create_secret('<STAFF_ASSERTION_KEY_CURRENT>', 'staff_assertion_key_v1');
select vault.create_secret('1', 'staff_assertion_key_current');
select vault.create_secret('',  'staff_assertion_key_previous');
select vault.create_secret('<scheduler bearer>', 'scheduler_bearer');
select vault.create_secret('https://<recover-worker domain>', 'worker_url');
```

**6. Create the Storage buckets** from `supabase/config.toml`:
- Run `supabase seed buckets --linked`. This creates `incoming` (1 MiB, jpeg/png/webp), `originals`, `variants` (public), `map_drafts` (4 MiB), and `maps` (public).
- In Dashboard > Storage > Settings, set the global upload limit to **4 MB** (F-96).

**7. S3 protocol.** In Dashboard > Storage > S3 Connection, enable it and create one access key. This key is the **Storage root credential** (D-16), so it goes into the `recover-worker` project only.

**8. Disable the Data API** in Dashboard > Project Settings > API (F-94, D-20). Recover uses direct Postgres connections only.

**9. Connection strings.** Use the transaction pooler (port 6543) with the custom-role username form (Appendix I item 16):

```
postgresql://recover_web.<ref>:<password>@<pooler-host>:6543/postgres
postgresql://recover_worker.<ref>:<password>@<pooler-host>:6543/postgres
```

**10. Cron.** Migration `0450_cron.sql` schedules the one-minute drain. It calls `worker_url` with `scheduler_bearer`, both read from Vault at call time (F-62). Nothing else is needed.

## 2. Google Cloud (staff sign-in and Vision)

**OAuth client (staff sign-in)**
- **Application type:** Web.
- **Authorized redirect URI:** `https://<web domain>/api/auth/callback/google`.
- **Where it goes:** `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` in `recover-web`. Put the district staff email domain(s) in `district_settings.staff_email_domains`.

**Vision** (optional until the screening evaluation, §10.3)
- Enable the Cloud Vision API.
- Create a Workload Identity pool with an OIDC provider:
  - issuer: `https://oidc.vercel.com/<team slug>`
  - allowed audience: `https://vercel.com/<team slug>`
  - condition: pinned to the `recover-worker` production subject
- Create a service account with Vision access, and allow the pool to impersonate it. No JSON key is ever created (F-92, D-19).
- Set `GCP_WIF_AUDIENCE`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_PROJECT_ID`, and `VISION_MODE=google` in `recover-worker`. Until then, use `VISION_MODE=off`: items arrive unscreened and humans still review everything.

## 3. Vercel (two projects, one repository)

| Project | Root directory | Holds |
|---|---|---|
| `recover-web` | `apps/web` | web DB login, Auth.js, assertion key, device/IP/search keys |
| `recover-worker` | `apps/worker` | worker DB login, **S3 key**, content key, scheduler hash, OIDC pins, GCP WIF |

1. **Build settings.** For each project run `vercel link` from the repo root and choose the root directory above. The framework is Next.js, the install command is `npm ci` (run at the repository root through workspaces), and the Node.js version is 22.x.
2. **OIDC.** In Team Settings > Security > OIDC Federation, enable team issuer mode. `recover-web` calls the worker with its OIDC token, so set `WORKER_OIDC_AUDIENCE` on the web project. On the worker, set `WEB_OIDC_ISSUER`, `WEB_OIDC_AUDIENCE`, `WEB_PROJECT_ID`, and `WEB_OWNER_ID` (F-93, F-121).
3. **Environment variables.** Set each project's variables from `.env.example` with `vercel env add <NAME> production`:
   - Never put `SUPABASE_S3_*` into `recover-web`.
   - Never set `RECOVER_DEV_LOGIN` or `RECOVER_DEV_AUTH` in any Vercel environment. Both are refused on Vercel and in any production build anyway (a production server that finds either set logs `dev_flags_ignored` once at startup).
4. **Deployment Protection.** Enable it on `recover-worker`, and add a protection bypass for the scheduler if the chosen mode blocks `pg_net` (O-24).
5. **Domain.** Use the district domain on `recover-web`. `recover-worker` keeps its Vercel domain; it has no public product routes.

## 4. Smoke test

```bash
curl -s https://<web>/offline -o /dev/null -w "%{http_code}\n"                      # 200
curl -s -X POST https://<worker>/api/jobs/run -o /dev/null -w "%{http_code}\n"      # 401, empty body
```

Then:
1. Sign in at `/staff` with a district Google account that the bootstrap invited.
2. Post a backfill item from `/staff/<CODE>/post?mode=backfill`.
3. Watch it publish and appear on `/s/<CODE>`.
4. Run `node scripts/repo-audit.mjs`.

## 5. Before enabling student posting

Work through Appendix J (`files (16)/18-Testing.md`). At minimum:
- the privilege diff and the tenant property tests are green (`npm run test:sql`);
- the storage limits hold against a live PUT;
- the screening evaluation is recorded;
- the restore quarantine has been drilled;
- two named owners are recorded for every account.

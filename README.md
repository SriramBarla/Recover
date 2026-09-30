# Recover

District-wide school lost-and-found.

- **Students** browse and search found items, post what they find, and file lost reports. They need no account.
- **Staff** sign in with their district Google account. They review every post before it becomes visible, and they manage custody from drop-off to claim.
- **District admins** onboard schools and approve campus maps.

> **Status:** under active construction. The foundation, database, worker, student app, and staff app are being built on feature branches and merged through pull requests. See [Build status](#build-status).

## How it works

```
Browser (student PWA / staff app)
   |  HTTPS only; no database or storage credentials in the browser
   v
recover-web  (Next.js, Vercel project 1)
   |  custom Postgres login `recover_web`: may only EXECUTE reviewed api_* functions
   |  staff calls also carry a 30-second HMAC "staff assertion" verified inside Postgres
   v
Supabase Postgres <---- recover_worker login (system_* functions only) ---- recover-worker (Next.js, Vercel project 2)
   ^                                                                             |
   |  pg_cron -> pg_net -> worker drain (jobs = transactional outbox)            |  the only holder of the Storage S3 key
   +-----------------------------------------------------------------------------+  sharp canonicalization, SigV4, Vision via OIDC
```

**Key properties** (full reasoning in the specification):

- **Human approval before publication.** Nothing a student posts is visible until staff approve it and every public image variant exists.
- **Tenancy enforced by the database.** Composite foreign keys make cross-school references fail inside the database, whatever the application code does.
- **No student personal data.** The only student datum is a school-scoped HMAC of a random, HttpOnly device cookie.
- **Canonicalized photos.** The worker decodes and re-encodes every photo, stripping its metadata, before any reviewer, screening provider, or public variant sees it.
- **Transactional side effects.** Side effects are jobs committed in the same transaction as the state change. Jobs are idempotent and safe to replay.

## Repository layout

```
apps/web/            Next.js app: student PWA (/s/[code]), staff app (/staff), district admin (/district)
apps/worker/         Next.js route handlers only: job drain, media broker, media gateway
packages/shared/     code both apps import (db wrapper, errors, DTOs, crypto, staff assertion, SigV4, ...)
supabase/            config, migrations (schema, roles, RLS, functions, cron), seed, SQL tests
tests/               node --test unit and integration suites, vectors, fuzz corpora
scripts/             dev runner, env generator, SQL test runner
BUILD-CONTRACT.md    the coordination contract: function catalog, routes, jobs, env, decisions
```

## Running it locally

**Prerequisites:**
- Node 22.18+ (built-in TypeScript type stripping)
- Docker (Colima works)
- Supabase CLI

```bash
npm install
supabase start              # Recover's local stack: API :55421, DB :55422
supabase db reset           # apply migrations + seed
node scripts/dev-env.mjs    # write apps/*/.env.local with fresh local keys
npm run dev                 # web :3000, worker :3001, dev scheduler
```

Then open:
- **Student app:** http://localhost:3000/s/FCHS
- **Staff app:** http://localhost:3000/staff. Locally, a dev-only sign-in is enabled with `RECOVER_DEV_LOGIN=1`; it is refused on Vercel.

**Tests:**

```bash
npm test            # unit tests (node --test)
npm run test:sql    # SQL assertions against the local database
npm run test:int    # integration tests (needs the local stack and apps running)
npm run typecheck
```

## Development workflow

- One branch per feature (`feat/<area>`), committed and pushed often.
- Every feature lands through a pull request into `main`.
- No secrets in the repository. Local keys live in the git-ignored `apps/*/.env.local` files.
- The specification library is kept locally and is not committed.

## Build status

| Area | Branch | State |
|---|---|---|
| Foundation (scaffold, contract, shared db/errors/dto/crypto/assertion) | `feat/foundation` | merged (#1) |
| Database schema, roles, RLS, private helpers, seed | `feat/db-schema` | merged (#2) |
| Dev tooling (dev runner, env generator, SQL test runner, map seeding) | `feat/dev-tooling` | merged (#3) |
| CI (repo audit, typecheck + unit, SQL suite on local Supabase) | `feat/ci` | merged (#4, #5) |
| Deployment guide and bootstrap template | `docs/deployment` | this change |
| Shared modules (SigV4, Unicode, rate limits, logging, matcher) | `feat/shared-modules` | in progress |
| Worker (jobs, media pipeline, screening, brokers) | `feat/worker` | in progress |
| Student PWA | `feat/student-web` | in progress |
| Staff and district apps | `feat/staff-web` | in progress |
| SQL functions: student, staff/district, system + cron | `feat/sql-*` | in progress |
| End-to-end integration tests | `feat/integration` | in progress |

## Further reading

- [`BUILD-CONTRACT.md`](BUILD-CONTRACT.md): function catalog, routes, jobs, environment, and the decisions applied to the specification.
- [`docs/DEPLOY.md`](docs/DEPLOY.md): Supabase, Vercel, and Google Cloud setup, then smoke tests.
- [`.env.example`](.env.example): every environment variable, with its purpose.

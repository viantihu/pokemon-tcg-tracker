# Pokémon TCG Tracker — DevOps & Environment Strategy

**Audience:** a Claude Code session that will scaffold and maintain the repo.
**Status:** greenfield. No code, no git, no production. Design docs and HTML
prototypes already exist in this folder (`system-design.md`, `sync-architecture.md`,
`sync-ui-spec.md`, `design/`).
**Written:** 2026-09-07.

This document defines source control, branching, environments, and CI/CD. It does
**not** define application features — those live in the design docs above. Read this
before running any `git init`, `vercel`, or `supabase` commands.

---

## 1. Goals and constraints

- Two long-lived environments: **Testing** and **Production**. Production does not
  exist yet and must be created cleanly, not promoted from ad-hoc local state.
- Single developer, single end user (Karvi). Keep the pipeline lightweight; every
  gate must earn its place. Do not over-engineer for a team that isn't there.
- The app is the **sole source of truth for placement** (binder / half / line /
  block). This data cannot be reconstructed from Dex. Durability and backups are
  therefore non-negotiable — this is the single most important input to the stack
  decision below.
- Installable responsive web app (PWA). No offline requirement. Cross-device use is
  real: phone for intake, desktop for bulk CSV work.
- GitHub for source, GitHub Actions for CI, Vercel for hosting (chosen).

---

## 2. Recommended stack (data model was left open — this resolves it)

**Recommendation: Next.js (App Router) on Vercel + Supabase for data.**

Two Supabase projects — one Testing, one Production — give a genuine two-environment
split with isolated databases, which is exactly what was asked for. Rationale:

- **Placement data is irreplaceable.** A managed Postgres with automated
  point-in-time backups beats client-only IndexedDB, which is one cleared-cache or
  lost-phone away from gone. This constraint alone rules out client-only for the
  production path.
- **Cross-device.** Supabase makes phone-intake and desktop-CSV-work see the same
  data without building a sync layer by hand.
- **Reconciliation fits a real DB.** The CSV snapshot-diff, unresolved queue, and
  copy-count reconciliation described in `sync-architecture.md` are far cleaner
  against relational tables than against browser storage.
- **Cost.** Free tiers on both Vercel and Supabase comfortably cover a single-user
  app across two environments.

Next.js is chosen because it is Vercel-native (zero-config deploys, preview URLs),
supports PWA installability, and its server routes are the right home for the
TCGdex proxy, CSV parsing, and perceptual-hashing work rather than shipping those to
the client.

> **If Karvi prefers client-only (IndexedDB) instead:** Sections 3, 5 (branching),
> 7 (quality gates), and 8 (CI) still apply unchanged. What collapses: there are no
> Supabase projects, no DB migrations (Section 6), and "environments" become a
> Testing preview deploy plus a Production deploy that differ only by build config.
> Flag this as an open decision at kickoff; everything else in this doc is robust to
> it.

---

## 3. Repository and source control

Single repo, single app. Suggested layout (Claude Code owns the details, but keep
DevOps files where CI expects them):

```
pokemon-tcg-tracker/
├── .github/workflows/      # CI/CD pipelines (Section 8)
├── app/                    # Next.js App Router
├── lib/                    # sync engine, TCGdex client, reconciliation
├── supabase/
│   ├── migrations/         # versioned SQL migrations
│   └── seed.sql            # deterministic seed data for Testing
├── public/                 # PWA manifest, icons
├── tests/
├── .env.example            # documents every required var, no secrets
├── .gitignore
└── README.md               # setup + this strategy's TL;DR
```

Source-control rules:

- `git init` at project root. First commit is scaffolding only, no secrets.
- `.gitignore` must exclude `.env*` (except `.env.example`), `node_modules`,
  `.next`, `.vercel`, `.DS_Store`, and any real Dex CSV exports (they contain the
  full collection and are personal data — never commit them; add a `*.csv` ignore
  with an allow-list exception only for tiny fixture files under `tests/`).
- **Never commit secrets.** Supabase service-role keys, in particular, must only
  ever live in Vercel/GitHub secret stores (Section 7).

---

## 4. Branching model

Trunk-based with one integration branch, sized for a solo developer:

- **`main`** → deploys to **Production**. Protected. No direct pushes.
- **`develop`** → deploys to **Testing**. Integration branch; feature work lands
  here first.
- **`feature/*`** → short-lived branches off `develop`. Each opens a PR into
  `develop` and gets a Vercel **preview deploy** automatically.

Flow: `feature/x` → PR → merges to `develop` (auto-deploys to Testing) → once
validated, PR from `develop` → `main` (deploys to Production).

Branch protection on `main` (and lighter protection on `develop`):

- Require the CI status check (Section 8) to pass before merge.
- Require the branch to be up to date before merge.
- Disallow force pushes and deletion.
- Solo-dev pragmatism: self-review is fine; do **not** require a second approver
  (there isn't one). Keep the PR step because it's the promotion gate and the place
  CI reports, not for peer review.

Commit hygiene: Conventional Commits (`feat:`, `fix:`, `chore:`) so history stays
scannable and a changelog can be generated later.

---

## 5. Environments

Two long-lived environments plus ephemeral previews.

| Environment | Branch | Vercel | Supabase project | Purpose |
|---|---|---|---|---|
| Preview | `feature/*` PRs | auto preview URL | Testing DB | Per-PR smoke check |
| Testing | `develop` | Testing deployment | `tcg-tracker-testing` | Integration, CSV re-sync trials, throwaway data |
| Production | `main` | Production deployment | `tcg-tracker-prod` | Real collection. Backups on. Treat as precious. |

Environment principles:

- **Preview deploys share the Testing database.** Fine for a solo project — do not
  point previews at Production.
- **Production database is never used for experiments.** All CSV-reconciliation and
  destructive-diff testing happens against Testing, which can be reset from
  `seed.sql` at will.
- **Exception, until go-live:** the real collection is being entered against Testing
  and promoted to Production once at cutover, so Testing is **sticky** and must not be
  reset while it holds it. See `go-live-runbook.md`, which also documents the exposure
  this creates (previews share the Testing DB).
- Each environment gets its own set of env vars (Section 7), keyed by Vercel's
  Production / Preview / Development scopes.

---

## 6. Database migrations and seeding

Use the Supabase CLI with versioned SQL migrations checked into `supabase/migrations/`.

- Migrations are **forward-only and ordered**; never edit a merged migration, add a
  new one.
- CI applies pending migrations to **Testing** on merge to `develop`, and to
  **Production** on merge to `main` — after the build passes, before the deploy is
  marked live (Section 8).
- `seed.sql` holds deterministic sample data (real cards only — verify collector
  numbers against TCGdex, per the standing project rule; fabricated numbers have
  broken things before). Testing can be reset to seed at any time; Production is
  never seeded after its first real import.
- Turn on Supabase automated backups / PITR for the Production project before the
  first real CSV import. This is the durability guarantee that justified the stack.
- Production's **first real import is a data promotion from Testing**, not a hand
  re-entry: `scripts/promote-collection.mjs`, procedure in `go-live-runbook.md`. It
  remaps `owner_id` to the Production `auth.users` uuid, which a raw `pg_dump` restore
  would not — that failure is silent and leaves Production looking empty forever.

---

## 7. Secrets and configuration

Every required variable is documented in `.env.example` with placeholder values.
Real values live only in secret stores.

Expected variables (names are the contract — keep them identical across sections):

```
NEXT_PUBLIC_SUPABASE_URL        # per-env, safe to expose to client
NEXT_PUBLIC_SUPABASE_ANON_KEY   # per-env, safe to expose to client
SUPABASE_SERVICE_ROLE_KEY       # per-env, SERVER ONLY — never NEXT_PUBLIC_, never client
SUPABASE_DB_PASSWORD            # CI only, for migrations
TCGDEX_BASE_URL                 # defaults ok, override per-env if proxying
```

Storage locations:

- **Vercel** → set the three runtime vars per scope (Production scope → prod
  Supabase, Preview scope → testing Supabase). Vercel injects these at build/runtime.
- **GitHub Actions secrets** → `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` (or a
  testing/prod pair), and any Vercel deploy token, used only by the migration and
  deploy jobs.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It is server-only.
  Guard against accidental `NEXT_PUBLIC_` prefixing in review.

---

## 8. CI/CD pipeline (GitHub Actions)

Two workflows.

**`ci.yml` — runs on every PR and every push to `develop`/`main`:**

1. Checkout, install (cached).
2. Lint (ESLint) + format check (Prettier).
3. Type check (`tsc --noEmit`).
4. Unit/integration tests (Section 9) — the sync reconciliation logic is the
   highest-value thing to cover.
5. Build (`next build`) to catch build-time breakage.

This is the required status check for branch protection. If it's red, nothing merges.

**`deploy.yml` — runs on push to `develop` (Testing) and `main` (Production):**

1. Wait for `ci.yml` to pass (or reuse the same jobs).
2. Apply pending Supabase migrations to the matching environment
   (`supabase db push` against Testing or Prod).
3. Trigger the Vercel deploy for that environment (Vercel's Git integration can do
   this automatically on push; if so, this job only runs migrations and lets Vercel
   handle the deploy).
4. Post-deploy smoke check: hit a health route and one read path; fail loudly if
   non-200.

Ordering matters: **migrate before deploy** so new code never meets an old schema.
For a genuinely destructive migration, apply it, verify on Testing, then promote.

Vercel's native Git integration already gives preview + branch deploys for free —
lean on it and keep Actions focused on quality gates + migrations rather than
re-implementing deploys.

---

## 9. Quality gates

- **ESLint + Prettier** — enforced in CI, not just locally.
- **TypeScript strict mode** — `tsc --noEmit` in CI.
- **Tests** — prioritize the CSV sync engine: snapshot-diff, copy-count
  reconciliation, variant-migration pairing, set-code/localId resolution
  (`me25→me02.5`, padding, `jpn_` prefix). These are the rules most likely to
  regress and hardest to catch by eye. Fixtures should be tiny real-CSV slices, not
  the full personal export.
- **Pre-commit hook (optional, recommended)** — Husky + lint-staged to run lint +
  format on staged files so CI rarely fails on trivia.
- **Dependabot** — weekly, low-noise, for security patches.

---

## 10. Deploy and rollback

- **Deploy:** merges drive deploys (Section 8). No manual production deploys from a
  laptop.
- **Rollback (code):** Vercel keeps immutable deployments — promote a previous good
  deployment instantly from the dashboard/CLI. This is the first-line rollback.
- **Rollback (schema):** because migrations are forward-only, a bad migration is
  fixed with a new compensating migration, not a down-migration. For anything risky,
  Production PITR (Section 6) is the safety net — but prefer catching it on Testing.
- **Golden rule:** any change touching placement data or the sync diff gets
  exercised on Testing with a real CSV re-import before it reaches `main`.

---

## 11. Bootstrap sequence for the Claude Code session

Do these in order. Stop and confirm with Karvi at the two marked gates.

1. **Confirm the stack** (Section 2). Vercel + Supabase, or client-only? Everything
   downstream forks here. **← confirm before proceeding.**
2. `git init`, add `.gitignore` and `.env.example`, first scaffolding commit. Create
   the GitHub repo (private) and push `main`.
3. Create `develop` from `main`. Set branch protection on both (Section 4).
4. Scaffold the Next.js app; confirm `next build` passes locally.
5. Create the two Supabase projects (`tcg-tracker-testing`, `tcg-tracker-prod`).
   Enable backups/PITR on prod. **← confirm project names / region with Karvi.**
6. Wire Vercel: import the repo, map env vars per scope (Section 7), set `main`→prod
   and `develop`→testing.
7. Add `ci.yml`, then `deploy.yml`. Open a throwaway PR to prove the pipeline is
   green end to end before writing feature code.
8. Author the initial migration + `seed.sql` (real cards only, verified against
   TCGdex).
9. Hand off to feature development against the design docs.

---

## 12. Open decisions to raise at kickoff

- **Data model** (Section 2) — the one real fork. Recommend Vercel + Supabase;
  needs Karvi's yes.
- **Auth** — single user. A simple Supabase email/magic-link login is enough to
  protect the data on the open web; decide whether even that is wanted or if an
  allow-listed single account suffices.
- **Custom domain** — needed for a clean PWA install, or is the Vercel URL fine to
  start?
- ~~**Testing data refresh cadence** — reset Testing from seed on every deploy, or
  keep it sticky between runs?~~ **RESOLVED:** sticky. The real collection is entered
  against Testing and promoted to Production once at go-live, so Testing must not be
  reset while it holds it (`go-live-runbook.md`). It reverts to throwaway after cutover.

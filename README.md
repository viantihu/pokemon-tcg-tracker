# Pokémon TCG Binder

Routes each card in a haul to a binder and half by an ordered rule cascade, and
tracks the state of every evolution line (filled / placeholder / block). It is a
placement engine, not a collection tracker — Dex remains the scanner and the
presence record; this app owns **where each card physically goes**.

Full product spec: [`docs/system-design.md`](docs/system-design.md). Sync design:
[`docs/sync-architecture.md`](docs/sync-architecture.md).

## Stack

- **Next.js 16 (App Router)** on **Vercel** — one responsive PWA, installable to the phone.
- **Supabase (Postgres)** — two projects (Testing / Production). Placement data is
  irreplaceable, so it lives in managed Postgres with automated backups, not the browser.
- **TCGdex** — the card catalog, mirrored locally.
- **TypeScript · Vitest · ESLint · Prettier.**

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase + TCGdex values
pnpm dev                     # http://localhost:3000
```

Health check: `GET /api/health` → `{ "status": "ok", ... }`.

## Scripts

| Command             | What it does                |
| ------------------- | --------------------------- |
| `pnpm dev`          | Dev server                  |
| `pnpm build`        | Production build            |
| `pnpm test`         | Run the test suite (Vitest) |
| `pnpm test:watch`   | Watch mode                  |
| `pnpm typecheck`    | `tsc --noEmit`              |
| `pnpm lint`         | ESLint                      |
| `pnpm format`       | Prettier write              |
| `pnpm format:check` | Prettier check (matches CI) |

## Layout

```
app/            Next.js App Router (UI + route handlers; /api/health)
lib/            Non-UI logic
  env.ts        Zod-validated environment contract
  supabase/     Browser + server Supabase clients
  sync/         Dex CSV reconciliation engine (the highest-value logic)
supabase/       Versioned SQL migrations + Testing seed
tests/          Vitest suites (sync engine covered first)
docs/           Product, sync, DevOps, and design specs + HTML prototypes
```

## Environments & workflow (TL;DR)

Trunk-based, sized for a solo developer. Full detail in
[`docs/devops-strategy.md`](docs/devops-strategy.md).

| Branch      | Deploys to | Database              |
| ----------- | ---------- | --------------------- |
| `feature/*` | PR preview | Testing               |
| `develop`   | Testing    | `tcg-tracker-testing` |
| `main`      | Production | `tcg-tracker-prod`    |

`feature/x` → PR → `develop` (auto-deploys to Testing) → validate → PR → `main`
(Production). CI (`.github/workflows/ci.yml`) must be green to merge: lint, format,
typecheck, test, build. Migrations run before the deploy is trusted.

**Never commit secrets or real Dex CSV exports.** Only `.env.example` and tiny test
fixtures are tracked.

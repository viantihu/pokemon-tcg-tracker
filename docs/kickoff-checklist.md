# Kickoff Checklist — run before writing any feature code

**For the Claude Code session.** Read [`dev-spec.md`](dev-spec.md) first. This is the gate you
clear before M1. Stop at the two `⛔ CONFIRM` steps and wait for Karvi.

## 0. Orient (5 min, no changes)
- [ ] Read `dev-spec.md`, `system-design.md`, `sync-architecture.md`, `sync-ui-spec.md`, `devops-strategy.md`.
- [ ] Confirm the repo is green: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] Confirm you are on `develop` (or branch `feature/*` off it). Never commit to `main` directly.

## 1. Clear the kickoff gates (dev-spec §7)
- [ ] ⛔ **CONFIRM — Auth:** magic-link + single allow-listed email + RLS on all tables? (decision §4)
- [ ] ⛔ **CONFIRM — Line binder assignment:** "active binder" for phase 1? (decision §3)
- [ ] **Supabase:** confirm project names (`tcg-tracker-testing`, `tcg-tracker-prod`) + region; enable
      PITR/backups on prod (needed before any real import).
- [ ] Note the vetoable-but-decided calls (§1, §2, §5, §6) — proceed unless Karvi objects.

## 2. Verify environment wiring (no secrets in git)
- [ ] `.env.example` covers every required var; real values only in Vercel/GitHub secret stores.
- [ ] `.gitignore` excludes `.env*` (except example), real `*.csv` exports, `node_modules`, `.next`.
- [ ] Vercel scopes mapped: Production→prod Supabase, Preview→testing Supabase.

## 3. Prove the pipeline before feature work
- [ ] Open a throwaway PR into `develop`; confirm CI (lint, format, typecheck, test, build) goes green
      end to end and a preview deploy comes up. Close it.

## 4. Start M1 (dev-spec §5)
- [ ] Branch `feature/m1-domain-schema` off `develop`.
- [ ] Write migration `0002_domain.sql` (all §4 entities + sync tables + RLS).
- [ ] Real-cards-only: verify every seed card against TCGdex before writing `seed.sql`.
- [ ] Meet the M1 acceptance criteria, then PR into `develop`.

**Do not** re-scaffold, introduce pocket/page addressing, use card names as the species key, or
commit fabricated card data or a real Dex CSV.

/**
 * UIL-128 — migration 0031: each account remembers it has seen the first-run tutorial.
 *
 * What must hold, on real Postgres (PGlite, every migration on disk):
 *   - the backfill marks every account that already has a binder, a card or a Dex import as done, and no other, so
 *     the tour never opens over a collection that is already set up (Karvi's, on Testing);
 *   - the repo reads "not done" for a new account, records it done, and is idempotent (a replay finished again);
 *   - one account's row is invisible and unwritable to another (the table carries 0002's owner rule).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { onboardingRepo } from "@/lib/repo";
import {
  applyMigration,
  asOwner,
  asSuperuser,
  freshRpcDb,
  MIGRATIONS,
  OWNER,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const FILE = MIGRATIONS.find((f) => f.endsWith("_onboarding.sql"))!;
const VERSION = FILE.split("_")[0];
const OTHER = "00000000-0000-0000-0000-000000000002";
const [WITH_COPY, WITH_IMPORT, EMPTY] = [
  "00000000-0000-0000-0000-00000000000a",
  "00000000-0000-0000-0000-00000000000b",
  "00000000-0000-0000-0000-00000000000c",
];

async function asUser(db: PGlite, id: string): Promise<void> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${id}', false);`);
  await db.exec(`set role authenticated;`);
}

async function doneOwners(db: PGlite): Promise<string[]> {
  await asSuperuser(db);
  const res = await db.query<{ owner_id: string }>(
    `select owner_id from onboarding order by owner_id`,
  );
  return res.rows.map((r) => r.owner_id);
}

let db: PGlite;
afterEach(async () => {
  await db.close();
});

describe("UIL-128 · 0031 backfill: accounts already set up start done", () => {
  beforeEach(async () => {
    db = await freshRpcDb({ before: VERSION });
    await db.exec(`
      insert into catalog_card (tcgdex_id, name) values ('sv03-004', 'Charmander');
      insert into binder (owner_id, name, type) values ('${OWNER}', 'KB-001', 'general');
      insert into copy (owner_id, catalog_card_id, role) values ('${WITH_COPY}', 'sv03-004', 'bulk');
      insert into dex_import (owner_id, file_total, row_count) values ('${WITH_IMPORT}', 1, 1);
    `);
    await applyMigration(db, FILE);
    await db.exec(`grant all on onboarding to authenticated;`);
  });

  it("marks the owner with a binder, the one with a card and the one with an import, once each", async () => {
    expect(await doneOwners(db)).toEqual([OWNER, WITH_COPY, WITH_IMPORT].sort());
  });

  it("an account with nothing is not marked, so its tour opens", async () => {
    expect(await doneOwners(db)).not.toContain(EMPTY);
    await asUser(db, EMPTY);
    expect(await onboardingRepo.tutorialDone(pgliteClient(db))).toBe(false);
  });

  it("the account that was set up reads done through the repo", async () => {
    await asOwner(db);
    expect(await onboardingRepo.tutorialDone(pgliteClient(db))).toBe(true);
  });
});

describe("UIL-128 · onboarding is per account", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
  });

  it("a new account reads not done, records it, and reads done", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    expect(await onboardingRepo.tutorialDone(client)).toBe(false);
    await onboardingRepo.markTutorialDone(client);
    expect(await onboardingRepo.tutorialDone(client)).toBe(true);
    expect(await doneOwners(db)).toEqual([OWNER]);
  });

  it("recording it again (a replay finished) keeps one row and moves the time", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    await onboardingRepo.markTutorialDone(client);
    await asSuperuser(db);
    await db.exec(
      `update onboarding set tutorial_done_at = '2026-01-01' where owner_id = '${OWNER}'`,
    );
    await asOwner(db);
    await onboardingRepo.markTutorialDone(client);
    await asSuperuser(db);
    const res = await db.query<{ n: number; moved: boolean }>(
      `select count(*)::int as n, bool_and(tutorial_done_at > '2026-01-02') as moved from onboarding`,
    );
    expect(res.rows[0]).toEqual({ n: 1, moved: true });
  });

  it("another account neither sees her row nor can write one for her", async () => {
    await asOwner(db);
    await onboardingRepo.markTutorialDone(pgliteClient(db));

    await asUser(db, OTHER);
    expect(await onboardingRepo.tutorialDone(pgliteClient(db))).toBe(false);
    await expect(
      db.exec(`insert into onboarding (owner_id) values ('${OWNER}') on conflict do nothing`),
    ).rejects.toThrow(/row-level security/);
    await db.exec(`delete from onboarding where owner_id = '${OWNER}'`);
    expect(await doneOwners(db)).toEqual([OWNER]);
  });
});

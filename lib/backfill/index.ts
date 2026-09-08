/**
 * M5 backfill — public surface (dev-spec §5 M5; system-design §7A).
 *
 * Pure logic (types, chain resolution, line invariants, write planners) plus the I/O orchestration
 * (context load, commit executors). Import from here.
 */

export * from "./types";
export * from "./resolve";
export * from "./plan";
export * from "./context";
export * from "./commit";

/**
 * A `DbClient` that records what a run asks the database, over any other client (usually `pgliteClient`): each table
 * read, with the filters it carried (`eq` as `col=value`, any other filter by its name), and each write payload sent to
 * `rpc`. For tests that pin HOW MANY reads a path makes, not how long they take (tests/plan/catalog-cache.test.ts's
 * rule: query counts, never elapsed time).
 */
import type { DbClient } from "@/lib/repo";

const FILTERS = new Set(["eq", "neq", "in", "is", "not", "ilike", "contains", "overlaps", "or"]);

export function recordingClient(inner: DbClient) {
  const reads: { table: string; filters: string[] }[] = [];
  const rpcs: unknown[] = [];
  const base = inner as unknown as {
    from(table: string): object;
    rpc(fn: string, args: unknown): Promise<unknown>;
  };
  const client = {
    from(table: string) {
      const read = { table, filters: [] as string[] };
      reads.push(read);
      const target = base.from(table);
      // Every builder call goes through, recorded; a call that returns the builder returns this proxy instead, so
      // the filters chained after it are seen too.
      const proxy: object = new Proxy(target, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (typeof prop === "string" && FILTERS.has(prop)) {
              read.filters.push(prop === "eq" ? `${String(args[0])}=${String(args[1])}` : prop);
            }
            const out = (v as (...a: unknown[]) => unknown).apply(t, args);
            return out === t ? proxy : out;
          };
        },
      });
      return proxy;
    },
    rpc(fn: string, args: unknown) {
      rpcs.push(args);
      return base.rpc(fn, args);
    },
  };
  return {
    db: client as unknown as DbClient,
    reads,
    rpcs,
    /** The filters of every read of the catalog table. With the cache warm: her stand-ins (`source=user`) only. */
    catalogReads: () => reads.filter((r) => r.table === "catalog_card").map((r) => r.filters),
    /** How many times her stand-ins were read: once per `loadCatalogCached` call, warm or cold. */
    standInReads: () =>
      reads.filter((r) => r.table === "catalog_card" && r.filters.includes("source=user")).length,
  };
}

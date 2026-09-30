// A second `applyMigrations()` call must be a no-op that leaves stored rows untouched; re-running
// the DDL would fail with `42P07 relation already exists`.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type Querier } from "../migration-runner.js";

// PGlite -> Querier adapter

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // PGlite's `query` takes a mutable `any[]`, not `ReadonlyArray<unknown>`.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        // PGlite's `Transaction` has no nested `transaction(...)`, and Postgres has none either.
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => {
        return fn(wrap(tx));
      });
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// Each test gets a fresh, empty in-memory PGlite instance and calls `applyMigrations` itself.

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(() => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  ctx = { pg, querier };
});

afterEach(async () => {
  // `close()` releases the WASM heap.
  await ctx.pg.close();
});

describe("applyMigrations", () => {
  it("is a no-op on a database that already has the schema, and keeps its rows", async () => {
    await applyMigrations(ctx.querier);
    await ctx.querier.query("INSERT INTO users (id) VALUES ($1)", [
      "00000000-0000-4000-8000-000000000001",
    ]);

    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    const users = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users",
    );
    expect(users.rows).toEqual([{ count: "1" }]);
  });
});

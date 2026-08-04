// Plan-006 T3.3 — `EventLogAnchorStore` behaviour.
//
// The store is the control plane's only writer of `event_log_anchors`, so this
// file covers the three properties the anchor write must hold:
//
//   * IDEMPOTENCY. A re-uploaded identical range is absorbed as a success with
//     `stored: false`, not raised as a conflict — daemons retry whenever an
//     attempt's outcome is unknown to them, and that is the normal case rather
//     than the exceptional one.
//   * COVERAGE, NOT EXACT-START. Two anchors sharing a `start_sequence` are
//     distinct commitments and BOTH persist (`Spec-006 §Post-Compaction
//     Integrity`). A store that deduped on `start_sequence` would silently drop
//     the compaction-covering anchor.
//   * METADATA ONLY (I-006-3-02 / ADR-017). A body carrying event content is
//     REFUSED at the store's own parse, independently of the router's
//     `.input()` parse — a boundary invariant enforced at exactly one layer
//     stops being enforced the moment a second caller appears.
//
// Driven against real PGlite rather than a mocked `Querier`: every property
// above is a property of the SQL and the DDL constraints, and a mock would
// assert only that the store built the string the test expected.
//
// Refs: Plan-006 T3.3, ADR-017,
// `docs/architecture/schemas/shared-postgres-schema.md` §Event Log Anchors.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnchorPayload, NodeId, SessionId } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { EventLogAnchorStore, UnknownAnchorSessionError } from "../anchor-store.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-00000000a001" as SessionId;
const ABSENT_SESSION_ID = "01970000-0000-7000-8000-00000000dead" as SessionId;
const NODE_ID = "node-alpha" as NodeId;
const ANCHORED_AT = "2026-08-04T00:00:00.000Z";

const MERKLE_ROOT_BASE64 = Buffer.alloc(32, 0x11).toString("base64");
const ROOT_SIGNATURE_BASE64 = Buffer.alloc(64, 0x22).toString("base64");

function anchorFixture(overrides: Partial<AnchorPayload> = {}): AnchorPayload {
  return {
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    startSequence: 1,
    endSequence: 1000,
    merkleRoot: MERKLE_ROOT_BASE64,
    rootSignature: ROOT_SIGNATURE_BASE64,
    anchoredAt: ANCHORED_AT,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — same rationale as the sibling
// migration tests: the dispatch contract forbids exporting a shared fixture)
// ----------------------------------------------------------------------------

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  store: EventLogAnchorStore;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  // Canonical runner — this file's subject is the STORE, so it wants the full
  // registered schema rather than a hand-stepped subset.
  await applyMigrations(querier);
  await querier.query("INSERT INTO sessions (id) VALUES ($1)", [SESSION_ID]);
  ctx = { pg, querier, store: new EventLogAnchorStore(querier) };
});

afterEach(async () => {
  await ctx.pg.close();
});

async function countAnchors(): Promise<number> {
  // `COUNT(*)::text` because Postgres returns BIGINT, which `pg` hydrates as a
  // string; the cast makes the value identical under both drivers.
  const probe = await ctx.querier.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM event_log_anchors",
  );
  return Number(probe.rows[0]?.count ?? "0");
}

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------

describe("EventLogAnchorStore.upload — idempotency", () => {
  it("stores a first anchor and reports stored: true", async () => {
    await expect(ctx.store.upload(anchorFixture())).resolves.toEqual({ stored: true });
    expect(await countAnchors()).toBe(1);
  });

  it("absorbs an identical re-upload as stored: false, WITHOUT raising", async () => {
    await ctx.store.upload(anchorFixture());

    // The load-bearing half is that this RESOLVES. A store that let the raw
    // `23505` escape would make the daemon's normal retry look like a fault and
    // would leave the anchor queued forever.
    await expect(ctx.store.upload(anchorFixture())).resolves.toEqual({ stored: false });
    expect(await countAnchors()).toBe(1);
  });

  it("keeps the FIRST signature when a re-upload of the same range carries a different one", async () => {
    // Two properties in one arm, and the second is what makes it worth writing.
    //
    // The range identity is the WHOLE key: the store does not compare payload
    // bytes, so a differing `root_signature` neither refuses nor conflicts.
    //
    // And `DO NOTHING` means FIRST-WRITER-WINS, not last. That is the half a
    // re-upload of byte-identical material can never observe — under
    // `DO UPDATE` it would report exactly the same `stored: false` and the same
    // row count while silently replacing the stored commitment. Asserting the
    // ORIGINAL bytes survive is the only thing that tells the two apart.
    await ctx.store.upload(anchorFixture());

    const differentSignature = Buffer.alloc(64, 0x33).toString("base64");
    expect(differentSignature).not.toBe(ROOT_SIGNATURE_BASE64);

    await expect(
      ctx.store.upload(anchorFixture({ rootSignature: differentSignature })),
    ).resolves.toEqual({ stored: false });
    expect(await countAnchors()).toBe(1);

    const probe = await ctx.querier.query<{ root_signature: Uint8Array }>(
      "SELECT root_signature FROM event_log_anchors WHERE start_sequence = 1",
    );
    const persisted = probe.rows[0]?.root_signature;
    expect(persisted).toBeDefined();
    expect(Buffer.from(persisted as Uint8Array).toString("base64")).toBe(ROOT_SIGNATURE_BASE64);
  });
});

// ----------------------------------------------------------------------------
// Coverage, not exact-start
// ----------------------------------------------------------------------------

describe("EventLogAnchorStore.upload — distinct ranges are not collapsed", () => {
  it("persists a wider covering anchor that shares a start_sequence", async () => {
    // Spec-006 §Post-Compaction Integrity: a compactor discarding [1,5000]
    // needs a covering witness, and the cadence anchor over [1,1000] does not
    // cover it. Both must land.
    await expect(
      ctx.store.upload(anchorFixture({ startSequence: 1, endSequence: 1000 })),
    ).resolves.toEqual({ stored: true });
    await expect(
      ctx.store.upload(anchorFixture({ startSequence: 1, endSequence: 5000 })),
    ).resolves.toEqual({ stored: true });
    expect(await countAnchors()).toBe(2);
  });

  it("scopes the key per node — the same range on another chain is a distinct commitment", async () => {
    await ctx.store.upload(anchorFixture());
    await expect(
      ctx.store.upload(anchorFixture({ nodeId: "node-beta" as NodeId })),
    ).resolves.toEqual({ stored: true });
    expect(await countAnchors()).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// I-006-3-02 — metadata only
// ----------------------------------------------------------------------------

describe("EventLogAnchorStore.upload — metadata-only enforcement (I-006-3-02)", () => {
  for (const smuggledMember of ["payload", "events", "pii_payload"] as const) {
    it(`REFUSES a body carrying \`${smuggledMember}\` at the store's own parse`, async () => {
      // Cast at the boundary because the whole point is a value TypeScript would
      // have rejected — this models untyped JSON reaching the store through a
      // future second caller that skipped the router's `.input()` parse.
      const smuggled = {
        ...anchorFixture(),
        [smuggledMember]: { secret: "event bytes that must never reach the control plane" },
      } as unknown as AnchorPayload;

      await expect(ctx.store.upload(smuggled)).rejects.toThrow();
      // And nothing landed — the refusal is BEFORE the write, not a rollback.
      expect(await countAnchors()).toBe(0);
    });
  }

  it("refuses a malformed commitment width rather than storing a truncated root", async () => {
    const truncated = anchorFixture({ merkleRoot: Buffer.alloc(31, 0x11).toString("base64") });
    await expect(ctx.store.upload(truncated)).rejects.toThrow();
    expect(await countAnchors()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Storage fidelity + the FK arm
// ----------------------------------------------------------------------------

describe("EventLogAnchorStore.upload — storage fidelity", () => {
  it("decodes the base64 commitments to their exact bytes and keeps the daemon's anchored_at", async () => {
    await ctx.store.upload(anchorFixture());

    const probe = await ctx.querier.query<{
      node_id: string;
      merkle_root: Uint8Array;
      root_signature: Uint8Array;
      anchored_at: Date;
    }>("SELECT node_id, merkle_root, root_signature, anchored_at FROM event_log_anchors");
    const row = probe.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // Byte-exact round trip. A base64 field stored as TEXT, or decoded with the
    // wrong alphabet, would surface here rather than years later as a signature
    // that will not verify.
    expect(Buffer.from(row.merkle_root).toString("base64")).toBe(MERKLE_ROOT_BASE64);
    expect(Buffer.from(row.root_signature).toString("base64")).toBe(ROOT_SIGNATURE_BASE64);
    expect(row.merkle_root.length).toBe(32);
    expect(row.root_signature.length).toBe(64);

    // The daemon's timestamp, not the server's `now()` default — the two copies
    // of one signed commitment must agree about when it happened.
    expect(row.anchored_at.toISOString()).toBe(ANCHORED_AT);
    expect(row.node_id).toBe(NODE_ID);
  });

  it("raises UnknownAnchorSessionError for an anchor naming an absent session", async () => {
    // A terminal client fault, not a retriable server fault: the FK can never be
    // satisfied by re-sending the same body, so the daemon needs a definitive
    // answer. This is also the backstop that keeps node-scope sentinel anchors
    // out of V1 control-plane storage.
    await expect(
      ctx.store.upload(anchorFixture({ sessionId: ABSENT_SESSION_ID })),
    ).rejects.toBeInstanceOf(UnknownAnchorSessionError);
    expect(await countAnchors()).toBe(0);
  });
});

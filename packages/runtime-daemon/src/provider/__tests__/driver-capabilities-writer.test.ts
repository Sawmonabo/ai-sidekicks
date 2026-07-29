// DriverCapabilitiesWriter — Plan-005 Phase 2 (T2.4).
//
// Exercises the 3-table atomic dual-write + the `runtime_node.capability_*`
// emission + cold-start hydration over a REAL Local SQLite handle via
// `openDatabase(":memory:")` — so the migration-0003 tables, their CHECK
// constraints, AND the real append path all fire end-to-end. The composition
// mirrors the production root: `SessionService(db)` →
// `RuntimeNodeEventEmitter({ sessionEvents })` → `DriverCapabilitiesWriter(db,
// emitter)`, all over the SAME `db` handle (the dual-write atomicity depends on
// the emitter's append running on that connection — the T2.5 wiring contract).
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * `Spec-005 §Required Behavior` (undeclared capabilities are unsupported — the cache the gate
//     reads): the 7-flag matrix round-trips through `driver_capabilities` and
//     `hydrate`, so a `false`/absent flag is faithfully reconstructed.
//   * `Spec-005 §Default Behavior` (declarations required at attach time, refreshed on provider
//     state change): the declare → refresh paths (declared / updated / noop).
//   * `Spec-005 §Recovery Consequences` (cache-as-source-of-truth; cold-start hydration without
//     round-tripping the driver): `hydrate` reconstructs the nested
//     `GetCapabilitiesResult` from the three tables.
//   * I-005-2 (the capability cache is the durable mirror the in-memory registry
//     reads): the flat snapshot persists and reconstructs faithfully; the emitted
//     event carries the FLAT `CapabilityDetails`.
//   * Atomicity / write-then-emit ordering: a throwing emit rolls back all three
//     table writes (no rows for that driver after the failed declare).
//
// Refs: Plan-005 §Phase 2 / T2.4, `Spec-005 §Required Behavior` (normalized
// events; undeclared-unsupported) + `Spec-005 §Per-Driver Capability Matrix`
// (Codex reasoning/model-mutation rows), CP-005-5,
// invariant I-005-2.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type GetCapabilitiesResult,
  type ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import { RuntimeNodeEventEmitter } from "../../node/node-event-emitter.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService } from "../../session/session-service.js";
import { DriverCapabilitiesWriter } from "../driver-capabilities-writer.js";
import { ProviderOutputValidationError } from "../provider-output-validation.js";

// ----------------------------------------------------------------------------
// Fixtures + per-test lifecycle
// ----------------------------------------------------------------------------

const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const DRIVER_NAME: string = "claude";
const CONTRACT_VERSION: string = "1.2.3";

// The full 7-flag matrix every snapshot must answer (Record<DriverCapabilityFlag>
// — un-omittable by the contract type). Sourced from the canonical
// `DRIVER_CAPABILITY_FLAGS` array (no 4th hardcoded copy): every flag defaults
// false, then `resume` + `tool_calls` are the baseline-true pair, then overrides.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

function makeResult(overrides: Partial<GetCapabilitiesResult> = {}): GetCapabilitiesResult {
  return {
    capabilities: {
      flags: makeFlags(),
      contractVersion: CONTRACT_VERSION,
    },
    tools: [],
    ...overrides,
  };
}

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

// An ADVANCING clock: each call returns a distinct timestamp, so a "no write on
// noop" assertion can be made non-vacuous if needed.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

// Wire the Phase-2 object graph over the current `db`, with a collision-
// free deterministic event-id source so `session_events.id` (TEXT PRIMARY KEY)
// never collides across emits. Returns the writer + the SessionService (so tests
// can read the emitted events off the same connection). The append opt-in is
// test-only: a production composition root wires Plan-006 T3.1's
// EventLogService as the emitter's SessionEventLog instead.
function makeWriter(now: () => string = makeAdvancingClock()): {
  writer: DriverCapabilitiesWriter;
  sessionService: SessionService;
} {
  const sessionService: SessionService = new SessionService(db, {
    allowUnsignedPlaceholderAppend: true,
  });
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    sessionEvents: sessionService,
    newEventId: () => `evt-${(idCounter++).toString()}`,
  });
  const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(db, emitter, now);
  return { writer, sessionService };
}

// ---- Direct table readers (raw rows, the durable side of the dual-write) ----

interface EventRow {
  readonly type: string;
  readonly category: string;
  readonly payload: string;
}

function readEventRows(sessionId: string): ReadonlyArray<EventRow> {
  return db
    .prepare(
      `SELECT type, category, payload
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .all(sessionId) as ReadonlyArray<EventRow>;
}

function countCapabilityRows(driverName: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM driver_capabilities WHERE driver_name = ?`)
    .get(driverName) as { readonly n: number };
  return row.n;
}

function readToolNames(driverName: string): string[] {
  const rows = db
    .prepare(`SELECT tool_name FROM driver_tools WHERE driver_name = ? ORDER BY tool_name`)
    .all(driverName) as ReadonlyArray<{ readonly tool_name: string }>;
  return rows.map((row) => row.tool_name);
}

function readToolIdempotencyClass(driverName: string, toolName: string): string | undefined {
  const row = db
    .prepare(`SELECT idempotency_class FROM driver_tools WHERE driver_name = ? AND tool_name = ?`)
    .get(driverName, toolName) as { readonly idempotency_class: string } | undefined;
  return row?.idempotency_class;
}

function countContractMetaRows(driverName: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly n: number };
  return row.n;
}

// ----------------------------------------------------------------------------
// First declare — writes all three tables + emits capability_declared
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — first declare", () => {
  it("returns {emitted:'declared'}, writes 7 capability rows + N tool rows + 1 meta row, emits capability_declared with the FLAT snapshot", () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "search", idempotency_class: "idempotent", description: "search the web" },
        { name: "write_file", idempotency_class: "compensable" },
      ],
    });

    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result,
    });
    expect(outcome).toEqual({ emitted: "declared" });

    // Durable side: 7 flag rows, 2 tool rows, 1 meta row.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(7);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search", "write_file"]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);

    // Timeline side: exactly one capability_declared carrying the FLAT snapshot.
    const events = readEventRows(SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.type).toBe("runtime_node.capability_declared");
    expect(event.category).toBe("runtime_node_lifecycle");

    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    // The FLAT CapabilityDetails (NOT the nested GetCapabilitiesResult) — flags +
    // contractVersion + canonical-order tools at the top level of the snapshot.
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      actor: null,
      capability: "provider-driver-claude",
      capabilityDetails: {
        flags: makeFlags(),
        contractVersion: CONTRACT_VERSION,
        tools: [
          { name: "search", idempotency_class: "idempotent", description: "search the web" },
          { name: "write_file", idempotency_class: "compensable" },
        ],
      },
    });
  });
});

// ----------------------------------------------------------------------------
// Identical re-declare — idempotent no-op (no event, rows unchanged)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — identical re-declare", () => {
  it("returns {emitted:'noop'}, emits NO second event, leaves the rows unchanged", () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [{ name: "search", idempotency_class: "idempotent" }],
    });

    expect(
      writer.declare({ sessionId: SESSION_ID, nodeId: NODE_ID, driverName: DRIVER_NAME, result }),
    ).toEqual({ emitted: "declared" });

    // Re-declare the SAME snapshot — idempotent no-op.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "noop" });

    // Still exactly one event (no spurious capability_updated).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
    // Rows unchanged.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(7);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Changed declare (flag flip) — capability_updated with prior + new snapshots
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — changed declare (flag flip)", () => {
  it("returns {emitted:'updated'} and emits capability_updated carrying prior + new FLAT snapshots", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Flip the `steer` flag false → true.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: makeFlags({ steer: true }),
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(outcome).toEqual({ emitted: "updated" });

    const events = readEventRows(SESSION_ID);
    expect(events.map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);
    const updated = events[1];
    expect(updated).toBeDefined();
    if (updated === undefined) return;
    const payload = JSON.parse(updated.payload) as Record<string, unknown>;
    const previousState = payload["previousState"] as { flags: Record<string, boolean> };
    const newState = payload["newState"] as { flags: Record<string, boolean> };
    expect(previousState.flags["steer"]).toBe(false);
    expect(newState.flags["steer"]).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// contractVersion-only bump — NOT swallowed as a no-op
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — contractVersion-only bump", () => {
  it("returns {emitted:'updated'} when only the contractVersion changes", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: makeFlags(),
          contractVersion: "2.0.0",
        },
      }),
    });
    expect(outcome).toEqual({ emitted: "updated" });

    // The durable meta row carries the new version.
    const meta = db
      .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly contract_version: string };
    expect(meta.contract_version).toBe("2.0.0");
  });
});

// ----------------------------------------------------------------------------
// Tool removed on refresh — delete-then-reinsert drops the orphan row
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool removed on refresh", () => {
  it("drops a removed tool's row (delete-then-reinsert) and returns {emitted:'updated'}", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable" },
        ],
      }),
    });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search", "write_file"]);

    // Refresh WITHOUT `write_file` — it must be deleted, not orphaned.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "updated" });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Tool with omitted idempotency_class — normalized to manual_reconcile_only
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool idempotency_class default (I-005-3)", () => {
  it("persists an omitted idempotency_class as 'manual_reconcile_only'", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      // No `idempotency_class` on the tool — the schema default fills it.
      result: makeResult({ tools: [{ name: "search" }] }),
    });

    expect(readToolIdempotencyClass(DRIVER_NAME, "search")).toBe("manual_reconcile_only");
  });
});

// ----------------------------------------------------------------------------
// Tools in different array order — canonical-ordering guard (no spurious update)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — canonical tool ordering", () => {
  it("treats the same tool set in a DIFFERENT array order as a no-op (spurious-update guard)", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "search", idempotency_class: "idempotent" },
          { name: "write_file", idempotency_class: "compensable" },
        ],
      }),
    });

    // SAME tools, REVERSED order — must canonicalize to the same snapshot → noop.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "write_file", idempotency_class: "compensable" },
          { name: "search", idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ emitted: "noop" });
    // No spurious second event.
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });

  it("uses BINARY (code-point) collation matching the reader — names that diverge under locale collation still no-op + hydrate in reader order", () => {
    // `"Search"` (uppercase 'S' = 0x53) sorts BEFORE `"add"` (lowercase 'a' =
    // 0x61) under SQLite BINARY collation, but a locale-aware `localeCompare`
    // would order `"add"` first — so these two names are the discriminating case
    // that catches a write-side sort using the WRONG collation (a mismatch would
    // make the write order disagree with the `ORDER BY tool_name` reader,
    // producing a spurious capability_updated AND a hydrate-order mismatch).
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "Search", idempotency_class: "idempotent" },
          { name: "add", idempotency_class: "compensable" },
        ],
      }),
    });

    // Re-declare the SAME pair in a DIFFERENT array order — must canonicalize to
    // the reader's BINARY order on BOTH sides → no-op (the spurious-update guard
    // for collation-divergent names).
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: "add", idempotency_class: "compensable" },
          { name: "Search", idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ emitted: "noop" });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);

    // hydrate returns tools in the reader's BINARY order — `"Search"` BEFORE
    // `"add"` — proving write-side and read-side collation coincide.
    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated?.tools.map((tool) => tool.name)).toEqual(["Search", "add"]);
  });

  it("sorts by UTF-8 BYTES (not JS UTF-16 code units): a supplementary-plane name re-declares as a no-op + hydrates in reader order (FINDING A)", () => {
    // The discriminating case the ASCII "Search"/"add" test CANNOT catch: JS
    // string `<`/`>` compares UTF-16 CODE UNITS, while SQLite `ORDER BY
    // tool_name` (no COLLATE → default BINARY) compares UTF-8 BYTES.
    //   * `\u{1F600}` (😀, supplementary plane) → UTF-16 lead surrogate 0xD83D,
    //     UTF-8 lead byte 0xF0.
    //   * `\u{E000}` (high-BMP private-use) → UTF-16 code unit 0xE000, UTF-8
    //     lead byte 0xEE.
    // JS says `\u{1F600}_tool < \u{E000}_tool` (0xD83D < 0xE000); SQLite BINARY
    // says the REVERSE (0xEE < 0xF0). Under the OLD JS-`<` comparator the
    // write-side order DISAGREES with the `ORDER BY tool_name` reader, so an
    // identical re-declare reads as "changed" (array-order-sensitive
    // `isDeepStrictEqual`) and fires a SPURIOUS `capability_updated`, AND hydrate
    // returns a different order than the write side. The UTF-8-byte comparator
    // makes both sides coincide → no-op + matching hydrate order.
    const supplementaryName = "\u{1F600}_tool"; // 😀_tool — UTF-8 lead byte 0xF0
    const highBmpName = "\u{E000}_tool"; // private-use — UTF-8 lead byte 0xEE
    const { writer } = makeWriter();

    // First declare establishes the snapshot (priorSnapshot === undefined, so the
    // spurious-update bug only manifests on the IDENTICAL re-declare below).
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: supplementaryName, idempotency_class: "idempotent" },
          { name: highBmpName, idempotency_class: "compensable" },
        ],
      }),
    });

    // Re-declare the IDENTICAL set in a DIFFERENT array order. The UTF-8-byte
    // sort canonicalizes BOTH sides to the reader's BINARY order → no-op.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [
          { name: highBmpName, idempotency_class: "compensable" },
          { name: supplementaryName, idempotency_class: "idempotent" },
        ],
      }),
    });
    expect(outcome).toEqual({ emitted: "noop" });
    // No spurious second event (under the old comparator this would be 2).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);

    // hydrate returns tools in the reader's BINARY (UTF-8 byte) order — the
    // high-BMP 0xEE name BEFORE the supplementary-plane 0xF0 name — matching the
    // write-side sort.
    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated?.tools.map((tool) => tool.name)).toEqual([highBmpName, supplementaryName]);
  });
});

// ----------------------------------------------------------------------------
// Invalid contract_version — throws + opens NO txn (tables untouched, no event)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid contract_version", () => {
  it("throws ProviderOutputValidationError and writes NO rows + NO event (txn never opened)", () => {
    const { writer } = makeWriter();
    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Non-canonical semver — rejected at the write seam BEFORE any txn opens.
        result: makeResult({
          capabilities: {
            flags: makeFlags(),
            contractVersion: "not-a-semver",
          },
        }),
      }),
    ).toThrow(ProviderOutputValidationError);

    // The tables must be completely untouched (the txn never opened).
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Invalid flags key-set — extra / missing flag rejected at the write seam
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid flags key-set", () => {
  it("throws ProviderOutputValidationError on an EXTRA (8th bogus) flag + writes NO rows + NO event", () => {
    const { writer } = makeWriter();
    // The nominal `Record<DriverCapabilityFlag, boolean>` forbids an unknown key,
    // so build an 8-key flags object and widen through `unknown` to reach the
    // write-seam cardinality guard (the boundary an untyped provider would hit).
    const extraFlags = { ...makeFlags(), nonsense_flag: true } as unknown as Record<
      DriverCapabilityFlag,
      boolean
    >;
    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: extraFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });

  it("throws ProviderOutputValidationError on a MISSING flag + writes NO rows + NO event", () => {
    const { writer } = makeWriter();
    const missingFlags = makeFlags();
    // Drop a canonical flag — the guard catches the <7 cardinality. Bracket
    // access because the `Record<string, boolean>` widening goes through an index
    // signature (`noPropertyAccessFromIndexSignature`).
    delete (missingFlags as Record<string, boolean>)["mcp"];
    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: missingFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });

  it("throws ProviderOutputValidationError on a SAME-cardinality wrong-key set (7 keys, one non-canonical) + writes NO rows + NO event", () => {
    const { writer } = makeWriter();
    // 7 keys but `mcp` swapped for a bogus name — cardinality (===7) passes, so
    // the per-flag own-key loop is the guard that must reject (canonical `mcp`
    // absent as an own key). This is the same-cardinality wrong-key case the loop
    // exists for; the extra/missing tests trip the cardinality guard first.
    const wrongKeyFlags = makeFlags();
    delete (wrongKeyFlags as Record<string, boolean>)["mcp"];
    (wrongKeyFlags as Record<string, boolean>)["bogus_flag"] = true;
    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: {
            flags: wrongKeyFlags as unknown as Record<DriverCapabilityFlag, boolean>,
            contractVersion: CONTRACT_VERSION,
          },
        }),
      }),
    ).toThrow(ProviderOutputValidationError);
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Malformed tool — leak-safe typed error (NOT raw ZodError), txn never opened
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — malformed tool metadata", () => {
  it("throws ProviderOutputValidationError (leak-safe, NOT ZodError) on a whitespace-only tool name + writes NO rows + NO event", () => {
    const { writer } = makeWriter();
    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Whitespace-only name — rejected by `wireFreeFormString`'s /\S/ guard,
        // surfaced as the leak-safe typed error (symmetric with contract_version).
        result: makeResult({ tools: [{ name: "   " }] }),
      }),
    ).toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Structurally-malformed result — leak-safe typed error (NOT raw TypeError),
// txn never opened (FINDING B)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — structurally-malformed result (leak-safe)", () => {
  // The static `GetCapabilitiesResult` type forbids these shapes, so each malformed
  // input is built and cast through `unknown` — the boundary an untyped provider
  // would actually hit. Pre-fix, `declare` dereferences `result.capabilities.<...>`
  // / `result.tools.map(...)` with NO structural guard and raw-throws a TypeError;
  // post-fix the leak-safe `ProviderOutputValidationError` is thrown BEFORE any txn
  // opens, so the tables stay untouched and no event is emitted.

  function expectLeakSafeReject(malformedResult: unknown): void {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: malformedResult as GetCapabilitiesResult,
      });
    } catch (error) {
      thrown = error;
    }
    // The DISCRIMINATOR vs pre-fix is the error TYPE + code (pre-fix: raw TypeError).
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).code).toBe("driver.provider_output_invalid");

    // No txn ever opened — all three driver tables untouched + no event emitted.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  }

  it("rejects a null `capabilities` as ProviderOutputValidationError (not a raw TypeError)", () => {
    expectLeakSafeReject({ capabilities: null, tools: [] });
  });

  it("rejects a null `flags` as ProviderOutputValidationError (not a raw TypeError)", () => {
    expectLeakSafeReject({
      capabilities: { flags: null, contractVersion: CONTRACT_VERSION },
      tools: [],
    });
  });

  it("rejects a null `tools` as ProviderOutputValidationError (not a raw TypeError)", () => {
    expectLeakSafeReject({
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: null,
    });
  });
});

// ----------------------------------------------------------------------------
// Sparse tools array — rejected at the shape guard, txn never opened (FIX D)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — sparse tools array (leak-safe, shape guard)", () => {
  it("rejects a SPARSE tools array (a hole) as ProviderOutputValidationError BEFORE any txn opens — closes the undefined-hole-deref class", () => {
    const { writer } = makeWriter();

    // Build a SPARSE array PROGRAMMATICALLY (not a literal `[a, , b]`, which the
    // `no-sparse-arrays` lint forbids): a valid tool at index 0, then bump the
    // length so index 1 is a HOLE (`length === 2`, only index 0 set). `Array.isArray`
    // is true for this, so the OLD guard's bare array-check would PASS it; the
    // `declare` `.map` then SKIPS the hole (leaving it in `normalizedTools`) and the
    // in-txn `for...of` insert loop iterates the hole as `undefined`, dereferencing
    // `undefined.name` — a raw TypeError from INSIDE an already-opened transaction.
    const validTool: ProviderToolMetadata = { name: "search", idempotency_class: "idempotent" };
    const sparseTools: ProviderToolMetadata[] = [];
    sparseTools[0] = validTool;
    sparseTools.length = 2; // index 1 is a HOLE
    expect(0 in sparseTools).toBe(true);
    expect(1 in sparseTools).toBe(false); // confirms the hole

    let thrown: unknown;
    try {
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Pass the sparse array by REFERENCE (object spread copies the reference, so
        // holes survive to the shape guard). NEVER route through an array spread —
        // `[...sparseTools]` densifies holes to `undefined` and defeats the test.
        result: makeResult({ tools: sparseTools }),
      });
    } catch (error) {
      thrown = error;
    }
    // Leak-safe typed error (pre-fix: raw TypeError from inside the txn).
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).code).toBe("driver.provider_output_invalid");
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");
    // The reason names the density/sparse contract (the documented rule).
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/dense|sparse/i);

    // No txn ever opened — all three driver tables untouched + NO event emitted.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// toJSON-tainted flags — snapshot clones flags into a fresh plain record (FIX E)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — toJSON-tainted flags (defensive snapshot clone)", () => {
  it("clones flags into a fresh plain record so serialized consumers see real booleans (not toJSON output) and an identical re-declare no-ops", () => {
    const { writer } = makeWriter();

    // All 7 canonical boolean flags, PLUS a NON-ENUMERABLE `toJSON` — so the
    // `assertValidCapabilityFlags` cardinality check (`Object.keys`, own ENUMERABLE
    // keys) still sees EXACTLY 7 and passes, but `JSON.stringify(snapshot)` would
    // (pre-fix, when flags is stored by reference) invoke `toJSON` and serialize
    // `{poisoned:true}` instead of the real flag booleans — tainting BOTH the
    // change-detection JSON round-trip AND the emitted event payload, while the raw
    // `flags[flag]` write loop sees the TRUE booleans → the rows DIVERGE from the
    // event payload AND an identical re-declare spuriously fires `capability_updated`.
    const taintedFlags = makeFlags({ steer: true, mcp: true }) as Record<string, unknown>;
    Object.defineProperty(taintedFlags, "toJSON", {
      value: () => ({ poisoned: true }),
      enumerable: false,
    });
    // Sanity: the own-ENUMERABLE key-set is still exactly the 7 canonical flags
    // (the non-enumerable toJSON does not inflate cardinality).
    expect(Object.keys(taintedFlags).sort()).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());

    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: taintedFlags as unknown as Record<DriverCapabilityFlag, boolean>,
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(outcome).toEqual({ emitted: "declared" });

    // (a) The three-table write carries the TRUE boolean values. `steer` + `mcp`
    // are the true pair (alongside the makeFlags baseline `resume` + `tool_calls`);
    // the rest are false. (This passes pre-fix too — the write loop never serializes
    // — so it is a coherence check, NOT the class-closing discriminator.)
    expect(countCapabilityRows(DRIVER_NAME)).toBe(7);
    const supportedByFlag = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT capability_flag, supported FROM driver_capabilities WHERE driver_name = ?`,
          )
          .all(DRIVER_NAME) as ReadonlyArray<{ capability_flag: string; supported: number }>
      ).map((row) => [row.capability_flag, row.supported === 1]),
    );
    expect(supportedByFlag).toEqual({
      resume: true,
      tool_calls: true,
      steer: true,
      mcp: true,
      interactive_requests: false,
      reasoning_stream: false,
      model_mutation: false,
    });

    // (b) CLASS-CLOSING DISCRIMINATOR: the SERIALIZED event payload carries the real
    // flag record, NOT `{poisoned:true}`. The DB-read path round-trips through
    // `JSON.stringify` at append time — exactly where the toJSON taint manifests.
    const declaredEvent = readEventRows(SESSION_ID)[0];
    expect(declaredEvent).toBeDefined();
    if (declaredEvent === undefined) return;
    const payload = JSON.parse(declaredEvent.payload) as {
      capabilityDetails: { flags: Record<string, boolean> };
    };
    expect(payload.capabilityDetails.flags).toEqual({
      resume: true,
      tool_calls: true,
      steer: true,
      mcp: true,
      interactive_requests: false,
      reasoning_stream: false,
      model_mutation: false,
    });
    // Belt-and-suspenders on the raw serialized bytes: the real flag keys are
    // present and the toJSON marker is absent.
    const flagsJson = JSON.stringify(payload.capabilityDetails.flags);
    expect(flagsJson).toContain("steer");
    expect(flagsJson).toContain("mcp");
    expect(flagsJson).not.toContain("poisoned");

    // (c) CLASS-CLOSING DISCRIMINATOR: a SECOND identical declare (same tainted
    // object) is a NO-OP — change-detection compares plain booleans on BOTH sides.
    // Pre-fix, the prior snapshot's `toJSON` would serialize `{poisoned:true}` on
    // one side and (depending on which side stored the raw object) diverge, firing a
    // spurious `capability_updated`.
    const secondOutcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: {
          flags: taintedFlags as unknown as Record<DriverCapabilityFlag, boolean>,
          contractVersion: CONTRACT_VERSION,
        },
      }),
    });
    expect(secondOutcome).toEqual({ emitted: "noop" });
    // Still exactly one event (no spurious capability_updated).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// contract_version build metadata — rejected (canonical-identity), documented
// contract rule with explicit reason (FINDING C)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — contract_version build metadata rejected", () => {
  it("rejects `1.2.3+build.5` (SemVer §10 build metadata) with a reason that names build metadata + writes NO rows", () => {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Build metadata is NON-identifying (SemVer §10): `semver.valid` STRIPS it
        // to `1.2.3`, so `=== value` fails and the canonical-identity refine
        // rejects it. Accepting it would let `+build.5` / `+build.6` denote the
        // SAME version yet store byte-different strings → spurious capability_updated.
        result: makeResult({
          capabilities: { flags: makeFlags(), contractVersion: "1.2.3+build.5" },
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("contract_version");
    // The surfaced reason explicitly references build metadata (the documented rule).
    expect((thrown as ProviderOutputValidationError).fields?.["reason"]).toMatch(/build metadata/i);

    // Rejected before any txn opened — tables untouched, no event.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Duplicate tool names — leak-safe typed error, pre-txn (tables untouched) (FIX 2)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — duplicate tool names", () => {
  it("throws ProviderOutputValidationError (field 'tools') on two tools sharing a name + opens NO txn (tables untouched, no event)", () => {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Two tools with the SAME name — pre-fix the second `#insertToolStmt.run`
        // violates the (driver_name, tool_name) PK INSIDE the txn, throwing a raw
        // SqliteError from an already-opened transaction. Post-fix this is caught
        // BEFORE the txn opens and surfaced as the leak-safe typed error.
        result: makeResult({
          tools: [
            { name: "search", idempotency_class: "idempotent" },
            { name: "search", idempotency_class: "compensable", description: "dup" },
          ],
        }),
      });
    } catch (error) {
      thrown = error;
    }
    // The DISCRIMINATOR vs pre-fix is the error TYPE/field (pre-fix: raw SqliteError).
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("tools");

    // No txn ever opened — all three driver tables untouched + no event emitted.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// No-description re-declare — NULL→omitted round-trip compares equal (noop)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — no-description tool round-trip", () => {
  it("treats a re-declare of a description-less tool as a noop (NULL→omitted round-trip is equal)", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });

    // Re-declare the identical description-less tool. The DB stores NULL; the
    // `#snapshot` reader omits `description` entirely, so the prior snapshot
    // compares deep-equal to the new one → noop.
    const outcome = writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "noop" });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Multi-driver isolation — distinct capability keys + no row/snapshot bleed
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — multi-driver isolation", () => {
  it("emits driver-name-suffixed capability keys and keeps each driver's rows + snapshot isolated", () => {
    const { writer } = makeWriter();

    const codexResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
      tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
    });
    const claudeResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
      tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
    });

    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: "codex",
      result: codexResult,
    });
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: "claude",
      result: claudeResult,
    });

    // (i) the two events carry DISTINCT driver-name-suffixed capability keys.
    const events = readEventRows(SESSION_ID);
    expect(events).toHaveLength(2);
    const capabilityKeys = events.map(
      (event) => (JSON.parse(event.payload) as { capability: string }).capability,
    );
    expect(capabilityKeys).toEqual(["provider-driver-codex", "provider-driver-claude"]);

    // (ii) no row bleed — each driver has its own 7 flag rows + its own tools.
    expect(countCapabilityRows("codex")).toBe(7);
    expect(countCapabilityRows("claude")).toBe(7);
    expect(readToolNames("codex")).toEqual(["codex_tool"]);
    expect(readToolNames("claude")).toEqual(["claude_tool"]);

    // (iii) hydrate returns each driver's own snapshot.
    expect(writer.hydrate("codex")).toEqual({
      capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
      tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
    });
    expect(writer.hydrate("claude")).toEqual({
      capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
      tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
    });
  });
});

// ----------------------------------------------------------------------------
// #snapshot cardinality invariant — corrupt cache (a deleted flag row) throws
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — #snapshot cardinality invariant", () => {
  it("throws on a corrupt cache (a flag row deleted out-of-band)", () => {
    const { writer } = makeWriter();
    writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Corrupt the cache out-of-band: drop one canonical flag row, leaving the
    // parent contract_meta row intact (so `#snapshot` passes the existence gate).
    db.prepare(
      `DELETE FROM driver_capabilities WHERE driver_name = ? AND capability_flag = 'mcp'`,
    ).run(DRIVER_NAME);

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/cardinality invariant/);
  });
});

// ----------------------------------------------------------------------------
// hydrate — round-trips the nested GetCapabilitiesResult; undefined on miss
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — hydrate (cold-start cache read)", () => {
  it("round-trips a declared driver into the nested GetCapabilitiesResult (canonical tool order)", () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "search", idempotency_class: "idempotent" },
      ],
    });
    writer.declare({ sessionId: SESSION_ID, nodeId: NODE_ID, driverName: DRIVER_NAME, result });

    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      capabilities: {
        flags: makeFlags(),
        contractVersion: CONTRACT_VERSION,
      },
      // Canonical (name-ascending) order — search before write_file — regardless
      // of the declared array order.
      tools: [
        { name: "search", idempotency_class: "idempotent" },
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
      ],
    });
  });

  it("returns undefined for a driver that was never written", () => {
    const { writer } = makeWriter();
    expect(writer.hydrate("never-seen")).toBeUndefined();
  });

  // FIX 4 regression: hydrate routes its three-SELECT `#snapshot` read through the
  // DEFERRED `#readTxn` (one consistent read snapshot, closing the torn-read
  // hazard a concurrent refresh would open between autocommit SELECTs). The
  // torn-read concurrency aspect is NOT deterministically unit-testable with
  // synchronous better-sqlite3 (no interleaving point between the SELECTs), so
  // this is a PATH-EXERCISING regression guard: it proves the read-transaction
  // path round-trips a multi-tool, multi-table snapshot coherently end-to-end.
  it("round-trips a multi-table snapshot THROUGH the deferred read-transaction path (torn-read guard)", () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "add", idempotency_class: "idempotent" },
        { name: "search", idempotency_class: "manual_reconcile_only" },
      ],
    });
    writer.declare({ sessionId: SESSION_ID, nodeId: NODE_ID, driverName: DRIVER_NAME, result });

    // The nested GetCapabilitiesResult reconstructed via the deferred read txn:
    // contractVersion (contract_meta), flags (driver_capabilities), and tools
    // (driver_tools) all cohere from the SAME consistent snapshot, in canonical
    // (name-ascending) order.
    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
      tools: [
        { name: "add", idempotency_class: "idempotent" },
        { name: "search", idempotency_class: "manual_reconcile_only" },
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
      ],
    });
  });
});

// ----------------------------------------------------------------------------
// Throwing emit rolls back the cache write — write-then-emit ordering + atomicity
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — atomic dual-write (throwing emit rolls back)", () => {
  it("rolls back all three table writes when the emit throws (no rows for that driver)", () => {
    const sessionService: SessionService = new SessionService(db, {
      allowUnsignedPlaceholderAppend: true,
    });
    // A REAL emitter whose append runs on the SAME connection, but whose emit is
    // forced to throw AFTER the writes ran inside the txn — an injected
    // `nextSequence` that throws makes `emitCapabilityDeclared` throw at append
    // time (the same atomicity probe NodeCapabilityService's test uses), proving
    // the write-then-emit ordering + transaction rollback.
    const throwingEmitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: sessionService,
      nextSequence: () => {
        throw new Error("forced emit failure");
      },
      newEventId: () => "evt-0",
    });
    const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(
      db,
      throwingEmitter,
      makeAdvancingClock(),
    );

    expect(() =>
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
      }),
    ).toThrow("forced emit failure");

    // The three table writes ran FIRST then rolled back when the emit threw — so
    // there are NO rows for the driver after the failed declare.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

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
//     reads): the flag matrix round-trips through `driver_capabilities` and
//     `hydrate`, so a `false`/absent flag is faithfully reconstructed.
//   * `Spec-005 §Default Behavior` (declarations required at attach time, refreshed on provider
//     state change): the declare → refresh paths (declared / updated / noop).
//   * `Spec-005 §Recovery Consequences` (cache-as-source-of-truth; cold-start hydration without
//     round-tripping the driver): `hydrate` reconstructs the COMPLETE nested
//     `GetCapabilitiesResult` — `cliVersion` included, from the
//     `driver_contract_meta` currency pair T2.6 persists — from the three tables,
//     and reports a typed MISS (with its cause) rather than fabricating a version
//     it does not hold.
//   * I-005-2 (the capability cache is the durable mirror the in-memory registry
//     reads): the flat snapshot persists and reconstructs faithfully; the emitted
//     event carries the FLAT `CapabilityDetails` — and deliberately NOT the
//     currency pair, which is cache currency rather than a capability.
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
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  type ProviderToolMetadata,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { RuntimeNodeEventEmitter } from "../../node/node-event-emitter.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService, UnsignedPlaceholderAppendToken } from "../../session/session-service.js";
import {
  DriverCapabilitiesWriter,
  type DriverCapabilityHydrationResult,
} from "../driver-capabilities-writer.js";
import {
  CLI_VERSION_RAW_MAX_LEN,
  CLI_VERSION_SEMVER_MAX_LEN,
  ProviderOutputValidationError,
} from "../provider-output-validation.js";

/**
 * Fixed-key {@link DaemonSigningKeySource} — this suite is about the producer's
 * dual-write, not key custody (`signing-key-source.test.ts` owns that).
 */
class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

/** One park: the test waits on `reached`, the read waits on `parked`. */
interface ParkGate {
  /** Resolves once a `read` has actually reached this park. */
  readonly reached: Promise<void>;
  /** Resolves once the test has released this park. */
  readonly parked: Promise<void>;
  arrive(): void;
  release(): void;
}

function makeParkGate(): ParkGate {
  let arrive!: () => void;
  let release!: () => void;
  const reached: Promise<void> = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const parked: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, parked, arrive, release };
}

/**
 * A key source that parks its first `parkCount` reads until each is released,
 * then behaves like the fixed one.
 *
 * This is the seam the cross-session race arms below need, and it is the real
 * production shape rather than an artificial hook: the key unseal is the async
 * step that opens the window between a declare's read-decide and its write, so
 * parking here reproduces exactly the interleaving `declare`'s prelude re-check
 * exists to catch.
 *
 * ONE PARK PER ATTEMPT, which is what makes the park COUNT the attempt count:
 * `declare` re-runs read-decide-emit from the top on the divergence sentinel and
 * each attempt reads the signing key once. A single park lets every retry run to
 * completion — enough for the arms that lose ONE race, and structurally unable
 * to reach the retry budget's exhaustion branch.
 */
class ParkingDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;
  readonly #gates: ReadonlyArray<ParkGate>;
  #readCount = 0;

  constructor(parkCount: number = 1) {
    this.#gates = Array.from({ length: parkCount }, () => makeParkGate());
  }

  /** Resolves once read #`index` (0-based) has reached its park. */
  parkReachedAt(index: number): Promise<void> {
    return this.#gateAt(index).reached;
  }

  /**
   * How many key reads have happened — i.e. how many ATTEMPTS `declare` made.
   * `declare` re-runs read-decide-emit from the top on the divergence sentinel
   * and each attempt reads the signing key exactly once, so this counter is the
   * only way a test can tell "committed on the first attempt" from "diverged,
   * retried, and then committed" — two outcomes that are otherwise identical in
   * both the returned result and the durable rows.
   */
  get attemptCount(): number {
    return this.#readCount;
  }

  /** Lets read #`index` (0-based) leave its park. */
  releaseAt(index: number): void {
    this.#gateAt(index).release();
  }

  async read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    const index: number = this.#readCount;
    this.#readCount += 1;
    if (index < this.#gates.length) {
      const gate: ParkGate = this.#gateAt(index);
      gate.arrive();
      await gate.parked;
    }
    return this.#privateKey;
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("ParkingDaemonSigningKeySource.create is not used by this suite"),
    );
  }

  #gateAt(index: number): ParkGate {
    const gate: ParkGate | undefined = this.#gates[index];
    if (gate === undefined) {
      throw new Error(
        `ParkingDaemonSigningKeySource: no park #${String(index)}; ${String(this.#gates.length)} were requested. A park index past the end means the arm and the retry budget disagree about how many attempts there are.`,
      );
    }
    return gate;
  }
}

// ----------------------------------------------------------------------------
// Fixtures + per-test lifecycle
// ----------------------------------------------------------------------------

const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const DRIVER_NAME: string = "claude";
const CONTRACT_VERSION: string = "1.2.3";

// The full flag matrix every snapshot must answer (Record<DriverCapabilityFlag>
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

// The REQUIRED `cliVersion` reading (T1.8) every advertised snapshot carries. It
// describes the LIVE READING rather than a capability, which is why T2.6 PERSISTS
// it (into `driver_contract_meta.cli_version_raw` / `cli_version_semver`, so
// `hydrate()` can return the complete `GetCapabilitiesResult`) while deliberately
// keeping it OUT of change-detection and out of every event payload.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// A SECOND, structurally distinct reading of the same driver — a provider
// upgrade. Used by the version-only arms, where the capability snapshot must be
// byte-identical and ONLY the version moves.
const UPGRADED_CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.9.001 (build 12)",
  semver: "2.9.1",
};

function makeResult(overrides: Partial<GetCapabilitiesResult> = {}): GetCapabilitiesResult {
  return {
    capabilities: {
      flags: makeFlags(),
      contractVersion: CONTRACT_VERSION,
    },
    tools: [],
    cliVersion: CLI_VERSION_REPORT,
    ...overrides,
  };
}

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  // The per-session append lock is a module singleton — reset between cases so
  // a leftover queue entry cannot stall the next case as an unrelated timeout.
  __resetSessionAppendLocksForTest();
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
// can read the emitted events off the same connection). The seam is
// ASYNC-TRANSACTIONAL post the Plan-006 T3.1 re-point (node-event-emitter.ts's
// header owns the contract): `EventLogService.append` over the SAME connection
// backs it, which is what lets a `transactionalPrelude` join its transaction.
function makeWriter(
  now: () => string = makeAdvancingClock(),
  signingKeySource: DaemonSigningKeySource = new FixedDaemonSigningKeySource(),
  eventIdPrefix: string = "evt",
): {
  writer: DriverCapabilitiesWriter;
} {
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    // The production append path over the SAME connection as the writer — the
    // wiring contract this writer's header states: the three table writes travel
    // as a `transactionalPrelude` and must join the append's transaction.
    sessionEvents: new EventLogService({
      db,
      signingKeySource,
    }),
    // Prefixed so two writers racing on ONE database cannot collide on
    // `session_events.id`, which is a TEXT PRIMARY KEY across all sessions.
    newEventId: () => `${eventIdPrefix}-${(idCounter++).toString()}`,
  });
  const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(db, emitter, now);
  return { writer };
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

function readContractVersion(driverName: string): string | undefined {
  const row = db
    .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly contract_version: string } | undefined;
  return row?.contract_version;
}

interface RawCliVersionPair {
  readonly cli_version_raw: string | null;
  readonly cli_version_semver: string | null;
}

/**
 * The DURABLE currency pair, read by DIRECT SELECT off the raw columns rather
 * than through `hydrate()`. That is the point: routing this assertion through
 * the writer's own reader would let a symmetric bug (write the wrong thing, read
 * it back) pass. The raw columns are the contract with `docs/architecture/schemas/local-sqlite-schema.md`.
 */
function readCliVersionPair(driverName: string): RawCliVersionPair | undefined {
  return db
    .prepare(
      `SELECT cli_version_raw, cli_version_semver
         FROM driver_contract_meta
        WHERE driver_name = ?`,
    )
    .get(driverName) as RawCliVersionPair | undefined;
}

/**
 * `driver_contract_meta.refreshed_at` — the witness that makes "zero-write noop"
 * a NON-VACUOUS claim. The suite's clock advances on every read, so a noop that
 * touched the row would move this stamp.
 */
function readContractMetaRefreshedAt(driverName: string): string | undefined {
  const row = db
    .prepare(`SELECT refreshed_at FROM driver_contract_meta WHERE driver_name = ?`)
    .get(driverName) as { readonly refreshed_at: string } | undefined;
  return row?.refreshed_at;
}

/**
 * Narrow a {@link DriverCapabilityHydrationResult} to its HIT arm, failing the
 * test on a miss (and NAMING the miss reason, so a regression reads as "expected
 * a hit, got cli_version_missing" rather than as an opaque undefined deref).
 */
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}

// ----------------------------------------------------------------------------
// First declare — writes all three tables + emits capability_declared
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — first declare", () => {
  it("returns {emitted:'declared'}, writes one capability row per flag + N tool rows + 1 meta row, emits capability_declared with the FLAT snapshot", async () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "search", idempotency_class: "idempotent", description: "search the web" },
        { name: "write_file", idempotency_class: "compensable" },
      ],
    });

    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result,
    });
    expect(outcome).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // Durable side: one row per canonical flag, 2 tool rows, 1 meta row.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
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
  it("returns {emitted:'noop'}, emits NO second event, leaves the rows unchanged", async () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [{ name: "search", idempotency_class: "idempotent" }],
    });

    expect(
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result,
      }),
    ).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // Re-declare the SAME snapshot — idempotent no-op.
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });

    // Still exactly one event (no spurious capability_updated).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
    // Rows unchanged.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Changed declare (flag flip) — capability_updated with prior + new snapshots
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — changed declare (flag flip)", () => {
  it("returns {emitted:'updated'} and emits capability_updated carrying prior + new FLAT snapshots", async () => {
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // Flip the `steer` flag false → true.
    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "updated", cliVersionRefreshed: false });

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
  it("returns {emitted:'updated'} when only the contractVersion changes", async () => {
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "updated", cliVersionRefreshed: false });

    // The durable meta row carries the new version.
    const meta = db
      .prepare(`SELECT contract_version FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly contract_version: string };
    expect(meta.contract_version).toBe("2.0.0");
  });
});

// ----------------------------------------------------------------------------
// cli_version currency pair (T2.6) — persisted on every mutating declare,
// refreshed side-band on a version-only re-declare, NEVER evented
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — cli_version pair persistence", () => {
  it("a THROWING accessor on the report surfaces as the typed leak-safe refusal, before any txn", async () => {
    // Codex PR #372 round 1: the property reads at step (0b) are inside the
    // same getter/Proxy threat model as the swap case below — a throwing
    // accessor must surface as `ProviderOutputValidationError`, never as the
    // provider object's own exception text, and must open no transaction.
    // Built literally for the same `makeResult`-spread reason as below.
    const throwingReport: DriverCliVersionReport = {
      get raw(): string {
        throw new Error("PROVIDER-CONTROLLED-SECRET-TEXT");
      },
      semver: CLI_VERSION_REPORT.semver,
    } as DriverCliVersionReport;
    const result: GetCapabilitiesResult = {
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: [],
      cliVersion: throwingReport,
    };

    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as Error).message).not.toContain("PROVIDER-CONTROLLED-SECRET-TEXT");
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe("cliVersion");
    const metaCount = db
      .prepare(`SELECT COUNT(*) AS n FROM driver_contract_meta WHERE driver_name = ?`)
      .get(DRIVER_NAME) as { readonly n: number };
    expect(metaCount.n).toBe(0);
  });

  it("validates and persists ONE snapshot of the report — a getter cannot swap the value after validation", async () => {
    // The write-side twin of the RuntimeBindingStore case. `declare` copies the
    // reading into a plain object at step (0b), BEFORE validating it, and every
    // later use — the assert, the `cliVersionRefreshed` comparison, the durable
    // upsert — reads that copy. A re-read after validation would persist this
    // fixture's SECOND value, which no validator saw.
    //
    // The result is built literally rather than through `makeResult`, whose
    // `...overrides` spread would itself evaluate the getter and hand `declare`
    // a plain object — the fixture would then pass no matter what `declare` did.
    let rawReads: number = 0;
    const mutatingReport: DriverCliVersionReport = {
      get raw(): string {
        rawReads += 1;
        return rawReads === 1 ? CLI_VERSION_REPORT.raw : "swapped-after-validation";
      },
      get semver(): string {
        return CLI_VERSION_REPORT.semver;
      },
    };
    const result: GetCapabilitiesResult = {
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: [],
      cliVersion: mutatingReport,
    };

    const { writer } = makeWriter();
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result,
    });

    expect(outcome).toEqual({ emitted: "declared", cliVersionRefreshed: true });
    // The mechanism: exactly ONE read of the provider's member…
    expect(rawReads).toBe(1);
    // …and the durable row carries the value that was validated.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("writes cli_version_raw / cli_version_semver on the FIRST declare and reports cliVersionRefreshed:true", async () => {
    const { writer } = makeWriter();

    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // Read the RAW columns by direct SELECT — the contract with
    // `docs/architecture/schemas/local-sqlite-schema.md`, not the writer's own reader.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("updates the pair on a CAPABILITY-changing declare that also carries a new reading", async () => {
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // A provider upgrade that ALSO flipped a capability — the pair rides the
    // ordinary mutating upsert, so both move in one transaction.
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });
    expect(outcome).toEqual({ emitted: "updated", cliVersionRefreshed: true });
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: UPGRADED_CLI_VERSION_REPORT.raw,
      cli_version_semver: UPGRADED_CLI_VERSION_REPORT.semver,
    });
  });

  it("reports cliVersionRefreshed:false on a capability-changing declare from the SAME build (the flag is about the ROW, not about whether a statement ran)", async () => {
    // The discriminator against the naive implementation ("the upsert wrote the
    // pair, therefore true"). The upsert DOES restate the pair here; the durable
    // value is unchanged, so the flag must read `false`.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
      }),
    });
    expect(outcome).toEqual({ emitted: "updated", cliVersionRefreshed: false });
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
  });

  it("VERSION-ONLY change: emits NO event, refreshes the pair side-band, and reports emitted:'noop' + cliVersionRefreshed:true", async () => {
    // THE SUBTLE ARM. Change-detection runs on the canonical capability snapshot
    // (flags / contractVersion / tools) and deliberately EXCLUDES `cliVersion` —
    // version metadata is cache currency, not a capability, so
    // `runtime_node.capability_updated` carrying two byte-identical snapshots
    // would be a false record of a capability change. But the mutating upsert is
    // the only OTHER writer of the pair, so without the side-write a provider
    // upgrade that changed no capability would strand the OLD version forever.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
    const refreshedAtBefore: string | undefined = readContractMetaRefreshedAt(DRIVER_NAME);
    expect(refreshedAtBefore).toBeDefined();

    // IDENTICAL capabilities / contractVersion / tools; ONLY the reading moves.
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        tools: [{ name: "search", idempotency_class: "idempotent" }],
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });

    // (a) The emission discriminant stays `"noop"` — the side-write is NOT a
    // fourth discriminant value, because nothing was emitted.
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: true });

    // (b) NO event row was appended. Asserted on the session's whole event
    // stream, so a `capability_updated` carrying identical snapshots would fail
    // here rather than pass as "an update happened".
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
    expect(readEventRows(SESSION_ID)[0]?.type).toBe("runtime_node.capability_declared");

    // (c) The RAW columns carry the NEW pair — the side-write actually landed.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: UPGRADED_CLI_VERSION_REPORT.raw,
      cli_version_semver: UPGRADED_CLI_VERSION_REPORT.semver,
    });
    // (d) …and `refreshed_at` ADVANCED, which is what makes (c) a WRITE rather
    // than a row that happened to already hold those bytes. The mirror of the
    // zero-write assertion in the identical-declare arm below.
    expect(readContractMetaRefreshedAt(DRIVER_NAME)).not.toBe(refreshedAtBefore);

    // (e) The capability rows are untouched by a version-only refresh — the
    // side-write is scoped to the parent row's two version columns plus its
    // stamp, never the three-table write set.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
    expect(readContractVersion(DRIVER_NAME)).toBe(CONTRACT_VERSION);
  });

  it("IDENTICAL declare (same snapshot, same reading) writes NOTHING — refreshed_at is unmoved and cliVersionRefreshed is false", async () => {
    // The zero-write noop, made NON-VACUOUS by the advancing clock: if the noop
    // branch ran its side-write unconditionally, `refreshed_at` would move to a
    // later stamp and this assertion would go red.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    const refreshedAtBefore: string | undefined = readContractMetaRefreshedAt(DRIVER_NAME);
    expect(refreshedAtBefore).toBeDefined();

    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });

    expect(readContractMetaRefreshedAt(DRIVER_NAME)).toBe(refreshedAtBefore);
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });

  it("keeps the cli_version pair OUT of every event payload (it is cache currency, not a capability)", async () => {
    // The Spec-005 detection-source precedent applied to the version pair: it is
    // a property of the READING, not of a capability, so it is deliberately not
    // mirrored onto the canonical `CapabilityDetails` event payload. Asserted on
    // the raw serialized bytes of BOTH event kinds, so a later widening that
    // folded the version into the payload goes red rather than silently changing
    // what a `runtime_node.capability_*` row means.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        cliVersion: UPGRADED_CLI_VERSION_REPORT,
      }),
    });

    const events = readEventRows(SESSION_ID);
    expect(events.map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);
    for (const event of events) {
      expect(event.payload).not.toContain("cliVersion");
      expect(event.payload).not.toContain(CLI_VERSION_REPORT.raw);
      expect(event.payload).not.toContain(UPGRADED_CLI_VERSION_REPORT.raw);
      expect(event.payload).not.toContain(UPGRADED_CLI_VERSION_REPORT.semver);
    }
  });
});

// ----------------------------------------------------------------------------
// Invalid cliVersion — leak-safe typed error, pre-txn (tables untouched) (T2.6)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid cliVersion report", () => {
  // Each case is rejected by `assertValidCliVersionReport` in the PRE-TXN ladder,
  // so the three driver tables stay untouched and no event is emitted — the same
  // "a rejected input never opens a transaction" doctrine the contract_version
  // and tool-metadata arms assert.
  async function expectCliVersionReject(cliVersion: unknown, expectedField: string): Promise<void> {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({ cliVersion: cliVersion as DriverCliVersionReport }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderOutputValidationError);
    expect((thrown as ProviderOutputValidationError).code).toBe("driver.provider_output_invalid");
    expect((thrown as ProviderOutputValidationError).fields?.["field"]).toBe(expectedField);

    // No txn ever opened — all three driver tables untouched + no event emitted.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  }

  it("rejects an EMPTY raw + writes NO rows", async () => {
    await expectCliVersionReject({ raw: "", semver: "2.1.234" }, "cli_version_raw");
  });

  it("rejects an EMPTY semver + writes NO rows", async () => {
    await expectCliVersionReject({ raw: CLI_VERSION_REPORT.raw, semver: "" }, "cli_version_semver");
  });

  it("rejects an OVERSIZE raw (one byte past the 128-char CHECK literal) + writes NO rows", async () => {
    // DEFENSE-IN-DEPTH, not a tautology: the length is derived from
    // `CLI_VERSION_RAW_MAX_LEN`, which is documented in lockstep with the
    // `length(cli_version_raw) <= 128` SQL CHECK. Delete the pre-txn guard and
    // this value reaches the DB, raising a raw `SqliteError` from INSIDE the
    // append's transaction — a different error type AND a violated doctrine.
    await expectCliVersionReject(
      { raw: "v".repeat(CLI_VERSION_RAW_MAX_LEN + 1), semver: "2.1.234" },
      "cli_version_raw",
    );
  });

  it("rejects an OVERSIZE semver (one byte past the 64-char CHECK literal) + writes NO rows", async () => {
    await expectCliVersionReject(
      { raw: CLI_VERSION_REPORT.raw, semver: "9".repeat(CLI_VERSION_SEMVER_MAX_LEN + 1) },
      "cli_version_semver",
    );
  });

  it("rejects a NUL-bearing raw + writes NO rows", async () => {
    // An embedded NUL is the class the SQL CHECK's `instr(..., char(0)) = 0`
    // clause exists for; the pre-txn guard must catch it FIRST so the failure is
    // a typed refusal rather than a constraint violation mid-transaction. Written
    // as the `\u0000` ESCAPE rather than a literal control byte so the fixture is
    // greppable and survives every editor/formatter round-trip.
    await expectCliVersionReject(
      { raw: "mock-provider-cli \u00002.1.234", semver: "2.1.234" },
      "cli_version_raw",
    );
  });

  it("rejects an ABSENT cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    // The static type forbids this, so it is cast through `unknown` — the
    // boundary an untyped provider actually hits. The bounded shape guard
    // (`assertValidGetCapabilitiesResultShape`) does NOT reach `cliVersion`, so
    // this arm is what proves the presence/type check is genuinely performed by
    // the imported validator rather than assumed.
    await expectCliVersionReject(undefined, "cliVersion");
  });

  it("rejects a NULL cliVersion as the leak-safe typed error (not a raw TypeError)", async () => {
    await expectCliVersionReject(null, "cliVersion");
  });
});

// ----------------------------------------------------------------------------
// Tool removed on refresh — delete-then-reinsert drops the orphan row
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool removed on refresh", () => {
  it("drops a removed tool's row (delete-then-reinsert) and returns {emitted:'updated'}", async () => {
    const { writer } = makeWriter();
    await writer.declare({
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
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "updated", cliVersionRefreshed: false });
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
  });
});

// ----------------------------------------------------------------------------
// Tool with omitted idempotency_class — normalized to manual_reconcile_only
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — tool idempotency_class default (I-005-3)", () => {
  it("persists an omitted idempotency_class as 'manual_reconcile_only'", async () => {
    const { writer } = makeWriter();
    await writer.declare({
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
  it("treats the same tool set in a DIFFERENT array order as a no-op (spurious-update guard)", async () => {
    const { writer } = makeWriter();
    await writer.declare({
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
    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });
    // No spurious second event.
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });

  it("uses BINARY (code-point) collation matching the reader — names that diverge under locale collation still no-op + hydrate in reader order", async () => {
    // `"Search"` (uppercase 'S' = 0x53) sorts BEFORE `"add"` (lowercase 'a' =
    // 0x61) under SQLite BINARY collation, but a locale-aware `localeCompare`
    // would order `"add"` first — so these two names are the discriminating case
    // that catches a write-side sort using the WRONG collation (a mismatch would
    // make the write order disagree with the `ORDER BY tool_name` reader,
    // producing a spurious capability_updated AND a hydrate-order mismatch).
    const { writer } = makeWriter();
    await writer.declare({
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
    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);

    // hydrate returns tools in the reader's BINARY order — `"Search"` BEFORE
    // `"add"` — proving write-side and read-side collation coincide.
    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual(["Search", "add"]);
  });

  it("sorts by UTF-8 BYTES (not JS UTF-16 code units): a supplementary-plane name re-declares as a no-op + hydrates in reader order (FINDING A)", async () => {
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
    await writer.declare({
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
    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });
    // No spurious second event (under the old comparator this would be 2).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);

    // hydrate returns tools in the reader's BINARY (UTF-8 byte) order — the
    // high-BMP 0xEE name BEFORE the supplementary-plane 0xF0 name — matching the
    // write-side sort.
    const hydrated = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.tools.map((tool) => tool.name)).toEqual([highBmpName, supplementaryName]);
  });
});

// ----------------------------------------------------------------------------
// Invalid contract_version — throws + opens NO txn (tables untouched, no event)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — invalid contract_version", () => {
  it("throws ProviderOutputValidationError and writes NO rows + NO event (txn never opened)", async () => {
    const { writer } = makeWriter();
    await expect(
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
    ).rejects.toThrow(ProviderOutputValidationError);

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
  it("throws ProviderOutputValidationError on an EXTRA (bogus) flag + writes NO rows + NO event", async () => {
    const { writer } = makeWriter();
    // The nominal `Record<DriverCapabilityFlag, boolean>` forbids an unknown key,
    // so build the canonical set PLUS one bogus key and widen through `unknown` to
    // reach the write-seam cardinality guard (the boundary an untyped provider
    // would hit). Derived from `makeFlags()`, so this stays an OVER-cardinality
    // case for whatever the canonical set currently is.
    const extraFlags = { ...makeFlags(), nonsense_flag: true } as unknown as Record<
      DriverCapabilityFlag,
      boolean
    >;
    await expect(
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: extraFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });

  it("throws ProviderOutputValidationError on a MISSING flag + writes NO rows + NO event", async () => {
    const { writer } = makeWriter();
    const missingFlags = makeFlags();
    // Drop a canonical flag — the guard catches the SHORT cardinality. Bracket
    // access because the `Record<string, boolean>` widening goes through an index
    // signature (`noPropertyAccessFromIndexSignature`).
    delete (missingFlags as Record<string, boolean>)["mcp"];
    await expect(
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: missingFlags, contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });

  it("throws ProviderOutputValidationError on a SAME-cardinality wrong-key set (right key COUNT, one non-canonical) + writes NO rows + NO event", async () => {
    const { writer } = makeWriter();
    // The canonical key COUNT, but `mcp` swapped for a bogus name — the cardinality
    // check passes, so the per-flag own-key loop is the guard that must reject
    // (canonical `mcp` absent as an own key). Delete-then-add off `makeFlags()`
    // keeps the count matching whatever the canonical set currently is. This is the same-cardinality wrong-key case the loop
    // exists for; the extra/missing tests trip the cardinality guard first.
    const wrongKeyFlags = makeFlags();
    delete (wrongKeyFlags as Record<string, boolean>)["mcp"];
    (wrongKeyFlags as Record<string, boolean>)["bogus_flag"] = true;
    await expect(
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
    ).rejects.toThrow(ProviderOutputValidationError);
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Malformed tool — leak-safe typed error (NOT raw ZodError), txn never opened
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — malformed tool metadata", () => {
  it("throws ProviderOutputValidationError (leak-safe, NOT ZodError) on a whitespace-only tool name + writes NO rows + NO event", async () => {
    const { writer } = makeWriter();
    await expect(
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        // Whitespace-only name — rejected by `wireFreeFormString`'s /\S/ guard,
        // surfaced as the leak-safe typed error (symmetric with contract_version).
        result: makeResult({ tools: [{ name: "   " }] }),
      }),
    ).rejects.toThrow(ProviderOutputValidationError);

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

  async function expectLeakSafeReject(malformedResult: unknown): Promise<void> {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
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

  it("rejects a null `capabilities` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({ capabilities: null, tools: [] });
  });

  it("rejects a null `flags` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({
      capabilities: { flags: null, contractVersion: CONTRACT_VERSION },
      tools: [],
    });
  });

  it("rejects a null `tools` as ProviderOutputValidationError (not a raw TypeError)", async () => {
    await expectLeakSafeReject({
      capabilities: { flags: makeFlags(), contractVersion: CONTRACT_VERSION },
      tools: null,
    });
  });
});

// ----------------------------------------------------------------------------
// Sparse tools array — rejected at the shape guard, txn never opened (FIX D)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — sparse tools array (leak-safe, shape guard)", () => {
  it("rejects a SPARSE tools array (a hole) as ProviderOutputValidationError BEFORE any txn opens — closes the undefined-hole-deref class", async () => {
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
      await writer.declare({
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
  it("clones flags into a fresh plain record so serialized consumers see real booleans (not toJSON output) and an identical re-declare no-ops", async () => {
    const { writer } = makeWriter();

    // All canonical boolean flags, PLUS a NON-ENUMERABLE `toJSON` — so the
    // `assertValidCapabilityFlags` cardinality check (`Object.keys`, own ENUMERABLE
    // keys) still sees EXACTLY the canonical set and passes, but
    // `JSON.stringify(snapshot)` would
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
    // Sanity: the own-ENUMERABLE key-set is still exactly the canonical flags
    // (the non-enumerable toJSON does not inflate cardinality).
    expect(Object.keys(taintedFlags).sort()).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());

    const outcome = await writer.declare({
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
    expect(outcome).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // (a) The three-table write carries the TRUE boolean values. `steer` + `mcp`
    // are the true pair (alongside the makeFlags baseline `resume` + `tool_calls`);
    // the rest are false. (This passes pre-fix too — the write loop never serializes
    // — so it is a coherence check, NOT the class-closing discriminator.)
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    const supportedByFlag = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT capability_flag, supported FROM driver_capabilities WHERE driver_name = ?`,
          )
          .all(DRIVER_NAME) as ReadonlyArray<{ capability_flag: string; supported: number }>
      ).map((row) => [row.capability_flag, row.supported === 1]),
    );
    // Derived from the SAME builder that produced the declared input, so widening
    // the flag union cannot leave a stale hand-written record asserting a subset.
    // It still closes the class: the poisoned form is `{poisoned:true}`, which no
    // canonical record equals.
    expect(supportedByFlag).toEqual(makeFlags({ steer: true, mcp: true }));

    // (b) CLASS-CLOSING DISCRIMINATOR: the SERIALIZED event payload carries the real
    // flag record, NOT `{poisoned:true}`. The DB-read path round-trips through
    // `JSON.stringify` at append time — exactly where the toJSON taint manifests.
    const declaredEvent = readEventRows(SESSION_ID)[0];
    expect(declaredEvent).toBeDefined();
    if (declaredEvent === undefined) return;
    const payload = JSON.parse(declaredEvent.payload) as {
      capabilityDetails: { flags: Record<string, boolean> };
    };
    expect(payload.capabilityDetails.flags).toEqual(makeFlags({ steer: true, mcp: true }));
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
    const secondOutcome = await writer.declare({
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
    expect(secondOutcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });
    // Still exactly one event (no spurious capability_updated).
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// contract_version build metadata — rejected (canonical-identity), documented
// contract rule with explicit reason (FINDING C)
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — contract_version build metadata rejected", () => {
  it("rejects `1.2.3+build.5` (SemVer §10 build metadata) with a reason that names build metadata + writes NO rows", async () => {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
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
  it("throws ProviderOutputValidationError (field 'tools') on two tools sharing a name + opens NO txn (tables untouched, no event)", async () => {
    const { writer } = makeWriter();
    let thrown: unknown;
    try {
      await writer.declare({
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
  it("treats a re-declare of a description-less tool as a noop (NULL→omitted round-trip is equal)", async () => {
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });

    // Re-declare the identical description-less tool. The DB stores NULL; the
    // `#snapshot` reader omits `description` entirely, so the prior snapshot
    // compares deep-equal to the new one → noop.
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
    });
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: false });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Multi-driver isolation — distinct capability keys + no row/snapshot bleed
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — multi-driver isolation", () => {
  it("emits driver-name-suffixed capability keys and keeps each driver's rows + snapshot isolated", async () => {
    const { writer } = makeWriter();

    const codexResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
      tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
    });
    const claudeResult: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
      tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
    });

    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: "codex",
      result: codexResult,
    });
    await writer.declare({
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

    // (ii) no row bleed — each driver has its own full flag-row set + own tools.
    expect(countCapabilityRows("codex")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countCapabilityRows("claude")).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames("codex")).toEqual(["codex_tool"]);
    expect(readToolNames("claude")).toEqual(["claude_tool"]);

    // (iii) hydrate returns each driver's own snapshot, each carrying its own
    // cached `cliVersion` off its own `driver_contract_meta` row.
    expect(writer.hydrate("codex")).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: "1.0.0" },
        tools: [{ name: "codex_tool", idempotency_class: "idempotent" }],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
    expect(writer.hydrate("claude")).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ mcp: true }), contractVersion: "2.0.0" },
        tools: [{ name: "claude_tool", idempotency_class: "compensable" }],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
  });
});

// ----------------------------------------------------------------------------
// #snapshot row-set invariant — corrupt cache (a wrong flag KEY SET) throws
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — #snapshot row-set invariant", () => {
  it("throws on a corrupt cache (a flag row deleted out-of-band)", async () => {
    const { writer } = makeWriter();
    await writer.declare({
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

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/row-set invariant/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/missing \[mcp\]/);
  });

  it("throws on a SAME-COUNT corrupt cache (`transcript_replay` swapped in for `mcp`)", async () => {
    // THE NEGATIVE CONTROL FOR THE COUNT-ONLY GUARD. The version-11 CHECK is a
    // superset whitelist — it admits all FOURTEEN canonical values while the
    // union declares THIRTEEN — so an out-of-band UPDATE can rename a canonical
    // row to `transcript_replay` and still satisfy both the CHECK and the row
    // COUNT. A guard comparing `flagRows.length` to
    // `DRIVER_CAPABILITY_FLAGS.length` passes this cache and hands back a flag
    // matrix with `mcp` silently absent; only the key-set proof catches it, and
    // it names BOTH directions so the operator sees which key vanished and which
    // one displaced it.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });

    // The out-of-band corruption a count-only guard cannot see: rename one
    // canonical row rather than deleting it. `transcript_replay` is admitted by
    // the version-11 CHECK (it is the fourteenth canonical value), so the UPDATE
    // commits.
    db.prepare(
      `UPDATE driver_capabilities
          SET capability_flag = 'transcript_replay'
        WHERE driver_name = ? AND capability_flag = 'mcp'`,
    ).run(DRIVER_NAME);

    // The count is UNMOVED — asserted, so this test cannot pass for the wrong
    // reason (an UPDATE that silently no-op'd, or one that left a short row set).
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);

    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/row-set invariant/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/missing \[mcp\]/);
    expect(() => writer.hydrate(DRIVER_NAME)).toThrow(/unexpected \[transcript_replay\]/);
  });
});

// ----------------------------------------------------------------------------
// hydrate — round-trips the nested GetCapabilitiesResult; undefined on miss
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — hydrate (cold-start cache read)", () => {
  it("round-trips a declared driver into the COMPLETE nested GetCapabilitiesResult (canonical tool order + cached cliVersion)", async () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "search", idempotency_class: "idempotent" },
      ],
    });
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result,
    });

    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      hit: true,
      result: {
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
        // The whole point of the T2.6 re-widening: `cliVersion` comes BACK from
        // the cache, so the return is the complete `GetCapabilitiesResult` a
        // caller can hand straight to the attach-time floor gate.
        cliVersion: CLI_VERSION_REPORT,
      },
    });
    // `detectionSource` is naturally ABSENT — it is not declared on
    // `GetCapabilitiesResult` (T3.24 owns it), and `Spec-005 §Interfaces And
    // Contracts` specifies its absence as reading "reconstructed from cache",
    // which is exactly what this return is. Asserted so a later widening that
    // fabricated a provenance value here goes red.
    expect(Object.keys(expectHydrationHit(hydrated))).not.toContain("detectionSource");
  });

  it("returns a MISS with reason 'never_written' for a driver that was never written", () => {
    const { writer } = makeWriter();
    // The REASON, not just `hit: false` — the two miss causes demand the same
    // caller behavior (refresh from the driver) but stay distinguishable, so a
    // regression collapsing them into one reason must go red HERE as well as on
    // the NULL-pair arm below.
    expect(writer.hydrate("never-seen")).toEqual({ hit: false, reason: "never_written" });
  });

  // FIX 4 regression: hydrate routes its three-SELECT `#snapshot` read through the
  // DEFERRED `#readTxn` (one consistent read snapshot, closing the torn-read
  // hazard a concurrent refresh would open between autocommit SELECTs). The
  // torn-read concurrency aspect is NOT deterministically unit-testable with
  // synchronous better-sqlite3 (no interleaving point between the SELECTs), so
  // this is a PATH-EXERCISING regression guard: it proves the read-transaction
  // path round-trips a multi-tool, multi-table snapshot coherently end-to-end.
  it("round-trips a multi-table snapshot THROUGH the deferred read-transaction path (torn-read guard)", async () => {
    const { writer } = makeWriter();
    const result: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
      tools: [
        { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        { name: "add", idempotency_class: "idempotent" },
        { name: "search", idempotency_class: "manual_reconcile_only" },
      ],
    });
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result,
    });

    // The nested GetCapabilitiesResult reconstructed via the deferred read txn:
    // contractVersion (contract_meta), flags (driver_capabilities), and tools
    // (driver_tools) all cohere from the SAME consistent snapshot, in canonical
    // (name-ascending) order.
    const hydrated = writer.hydrate(DRIVER_NAME);
    expect(hydrated).toEqual({
      hit: true,
      result: {
        capabilities: { flags: makeFlags({ steer: true, mcp: true }), contractVersion: "3.1.4" },
        tools: [
          { name: "add", idempotency_class: "idempotent" },
          { name: "search", idempotency_class: "manual_reconcile_only" },
          { name: "write_file", idempotency_class: "compensable", description: "write a file" },
        ],
        cliVersion: CLI_VERSION_REPORT,
      },
    });
  });

  // --------------------------------------------------------------------------
  // NULL currency pair — a cache MISS, never a fabricated version (T2.6)
  // --------------------------------------------------------------------------

  it("returns a MISS with reason 'cli_version_missing' when the stored pair is NULL (a pre-T1.7 row) — the version is NEVER fabricated", async () => {
    // THE NEGATIVE CONTROL FOR THE NULL-PAIR BRANCH. `docs/architecture/schemas/local-sqlite-schema.md`
    // states the rule outright on the `cli_version_semver` column: "cold-start
    // hydration MUST treat a NULL pair as a cache miss and refresh from the
    // driver — the required `GetCapabilitiesResult.cliVersion` is never
    // fabricated from cache". Delete the branch that implements it and this test
    // goes red three ways at once: the assertion is on `{ hit: false, reason }`
    // as a WHOLE, so a hit arm carrying `{ raw: null, semver: null }`, a hit arm
    // carrying `{ raw: "", semver: "" }`, and a miss reporting the OTHER reason
    // (`"never_written"`) all fail. The `reason` VALUE is what closes the last
    // of those — `expect(hydrated.hit).toBe(false)` alone would pass a branch
    // that returned the wrong cause.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    // Sanity: the pair IS populated by the declare, so the NULL-ing below is a
    // real state change rather than a no-op that would make this arm vacuous.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });

    // The pre-T1.7 row shape, reproduced out-of-band: the parent row EXISTS (so
    // the existence gate passes and `#snapshot` reconstructs a full, valid
    // capability matrix) but the currency pair is NULL. Both columns together —
    // the table's both-or-neither CHECK rejects NULL-ing just one.
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);

    expect(writer.hydrate(DRIVER_NAME)).toEqual({
      hit: false,
      reason: "cli_version_missing",
    });
    // And the miss is about the VERSION, not about the capability rows — those
    // are all still present and reconstructible. Asserting this is what keeps
    // the two miss reasons from being read as interchangeable.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });

  it("self-heals a NULL-pair row on the next declare: the miss becomes a hit and cliVersionRefreshed reports the repair", async () => {
    // The complement of the arm above. A NULL pair is a MISS, and the caller's
    // prescribed remedy is to refresh from the driver — which lands back here as
    // a declare. That declare's capability snapshot is IDENTICAL, so it takes
    // the noop branch; without the noop-branch side-write the row would stay
    // NULL forever and the driver would be permanently un-hydratable.
    const { writer } = makeWriter();
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);
    expect(writer.hydrate(DRIVER_NAME)).toEqual({ hit: false, reason: "cli_version_missing" });

    // The remedy: re-declare the SAME capability snapshot with a live reading.
    const outcome = await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult(),
    });
    // No event (the capabilities did not change), but the pair WAS repaired.
    expect(outcome).toEqual({ emitted: "noop", cliVersionRefreshed: true });
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME)).cliVersion).toEqual(CLI_VERSION_REPORT);
  });
});

// ----------------------------------------------------------------------------
// Throwing emit rolls back the cache write — write-then-emit ordering + atomicity
// ----------------------------------------------------------------------------

describe("DriverCapabilitiesWriter — atomic dual-write (a failed event write rolls back)", () => {
  it("rolls back all three table writes when the event INSERT throws (no rows for that driver)", async () => {
    // The three table writes are now a `transactionalPrelude` that runs INSIDE
    // the append's transaction, immediately BEFORE the event-row INSERT. To
    // exercise ROLLBACK specifically, the failure must land AFTER the prelude
    // has already applied — so the emitter is pinned to an event id that ALREADY
    // EXISTS, making the INSERT violate `session_events`' TEXT PRIMARY KEY. A
    // pre-transaction refusal would not test rollback at all (the next case
    // covers that stronger property separately).
    const seedingService: SessionService = new SessionService(db, {
      allowUnsignedPlaceholderAppend: UnsignedPlaceholderAppendToken.forTestsOnly(),
    });
    seedingService.append({
      id: "evt-collide",
      sessionId: SESSION_ID,
      sequence: 0,
      occurredAt: "2026-06-02T12:00:00.000Z",
      monotonicNs: 1_000_000_000n,
      category: "session_lifecycle",
      type: "session.created",
      actor: null,
      payload: { sessionId: SESSION_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    });

    const collidingEmitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: new EventLogService({
        db,
        signingKeySource: new FixedDaemonSigningKeySource(),
      }),
      newEventId: () => "evt-collide",
    });
    const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(
      db,
      collidingEmitter,
      makeAdvancingClock(),
    );

    await expect(
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
      }),
    ).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint/i);

    // The three table writes ran FIRST then rolled back when the INSERT threw —
    // so there are NO rows for the driver after the failed declare, and the only
    // event on the session is the seed.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(1);
  });

  it("never RUNS the table writes when the append refuses before opening its transaction", async () => {
    // The property the re-point made STRONGER than rollback: a refusal raised
    // before the transaction opens means the prelude never executes at all, so
    // there is no partial state to roll back. A regression that moved the
    // prelude ahead of the append's pre-transaction checks would still pass the
    // rollback arm above while breaking this one.
    class FailingSigningKeySource implements DaemonSigningKeySource {
      read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
        return Promise.reject(new Error("key unseal refused"));
      }
      create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
        return Promise.reject(new Error("unused"));
      }
    }
    const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
      sessionEvents: new EventLogService({ db, signingKeySource: new FailingSigningKeySource() }),
    });
    const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(
      db,
      emitter,
      makeAdvancingClock(),
    );

    await expect(
      writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({ tools: [{ name: "search", idempotency_class: "idempotent" }] }),
      }),
    ).rejects.toThrow("key unseal refused");

    expect(countCapabilityRows(DRIVER_NAME)).toBe(0);
    expect(readToolNames(DRIVER_NAME)).toEqual([]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(0);
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Cross-session concurrency — the window the SESSION-keyed lock cannot close
// ----------------------------------------------------------------------------

// The second session in the race arms. The driver-keyed tables have no
// `session_id` column, so two declares for ONE driver under DIFFERENT sessions
// hold DIFFERENT append locks and both reach their read-decide — the exact
// window `declare`'s in-prelude re-check plus bounded retry exists to close.
const SECOND_SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f01";

// `DRIVER_DECLARE_MAX_ATTEMPTS` from `driver-capabilities-writer.ts`, re-spelled
// here rather than exported: the constant is module-private BY DESIGN (nothing
// outside the retry loop may branch on the budget), and exporting a symbol for a
// test's convenience widens the module's surface for no production reason. The
// exhaustion arm below fails loudly if the two disagree — a budget larger than
// this leaves the parked declare waiting on a park that was never requested, and
// a smaller one rejects before the loop finishes.
const DECLARE_ATTEMPT_BUDGET: number = 3;

/** Every `runtime_node.capability_*` row across BOTH sessions, in commit order. */
function readCapabilityEventsAcrossSessions(): ReadonlyArray<EventRow> {
  return db
    .prepare(
      `SELECT type, category, payload
         FROM session_events
        WHERE session_id IN (?, ?) AND type LIKE 'runtime_node.capability_%'
        ORDER BY rowid ASC`,
    )
    .all(SESSION_ID, SECOND_SESSION_ID) as ReadonlyArray<EventRow>;
}

interface CapabilityEventPayload {
  readonly capabilityDetails?: FlatCapabilitySnapshot;
  readonly previousState?: FlatCapabilitySnapshot;
  readonly newState?: FlatCapabilitySnapshot;
}

interface FlatCapabilitySnapshot {
  readonly contractVersion?: string;
  readonly flags?: Record<string, boolean>;
  readonly tools?: ReadonlyArray<{ readonly name?: string }>;
}

function payloadOf(row: EventRow): CapabilityEventPayload {
  return JSON.parse(row.payload) as CapabilityEventPayload;
}

describe("DriverCapabilitiesWriter — concurrent declares under DIFFERENT sessions", () => {
  it("emits exactly ONE capability_declared when both racers declare the SAME snapshot", async () => {
    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const { writer: parkedWriter } = makeWriter(makeAdvancingClock(), parkedKeySource, "parked");
    const { writer: racingWriter } = makeWriter(makeAdvancingClock(), undefined, "racer");
    const snapshot: GetCapabilitiesResult = makeResult({
      tools: [{ name: "search", idempotency_class: "idempotent" }],
    });

    // The parked writer reads "no row", decides FIRST-DECLARE, and stalls in the
    // key unseal holding only session 1's lock.
    const parkedDeclare = parkedWriter.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: snapshot,
    });
    await parkedKeySource.parkReachedAt(0);

    // The racer runs to completion on session 2's uncontended lock.
    const racerOutcome = await racingWriter.declare({
      sessionId: SECOND_SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: snapshot,
    });
    expect(racerOutcome.emitted).toBe("declared");

    parkedKeySource.releaseAt(0);
    const parkedOutcome = await parkedDeclare;

    // The loser's prelude re-check saw the racer's committed snapshot, aborted
    // its stale first-declare, retried, and found the snapshot IDENTICAL — so it
    // took the idempotent no-op branch rather than emitting a second
    // `capability_declared` for one logical declaration.
    expect(parkedOutcome.emitted).toBe("noop");

    // Asserted on the UNION of both sessions: a per-session count would show one
    // event in each and call that correct.
    const events = readCapabilityEventsAcrossSessions();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("runtime_node.capability_declared");
    // And the durable side stayed single-declaration.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual(["search"]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
  });

  it("reclassifies the loser to capability_updated whose previousState is the RACER'S committed snapshot", async () => {
    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const { writer: parkedWriter } = makeWriter(makeAdvancingClock(), parkedKeySource, "parked");
    const { writer: racingWriter } = makeWriter(makeAdvancingClock(), undefined, "racer");

    const parkedDeclare = parkedWriter.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "loser_tool", idempotency_class: "idempotent" }] }),
    });
    await parkedKeySource.parkReachedAt(0);

    await racingWriter.declare({
      sessionId: SECOND_SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ resume: false }), contractVersion: "9.9.9" },
        tools: [{ name: "racer_tool", idempotency_class: "compensable" }],
      }),
    });

    parkedKeySource.releaseAt(0);
    const parkedOutcome = await parkedDeclare;

    // NOT `declared` — the loser's stale decision was first-declare, and shipping
    // it would have emitted a second `capability_declared` for a driver that
    // already had one.
    expect(parkedOutcome.emitted).toBe("updated");

    const events = readCapabilityEventsAcrossSessions();
    expect(events.map((row) => row.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);

    // THE LOAD-BEARING HALF. `previousState` must be what the racer COMMITTED,
    // not the absent-snapshot the loser read before the race. A retry that
    // reused its stale read would describe a transition that never happened.
    const updated = payloadOf(events[1] as EventRow);
    expect(updated.previousState?.contractVersion).toBe("9.9.9");
    expect(updated.previousState?.flags?.["resume"]).toBe(false);
    expect(updated.previousState?.tools?.map((tool) => tool.name)).toEqual(["racer_tool"]);
    // And `newState` is the loser's own snapshot, now correctly framed as a change.
    expect(updated.newState?.contractVersion).toBe(CONTRACT_VERSION);
    expect(updated.newState?.tools?.map((tool) => tool.name)).toEqual(["loser_tool"]);
  });

  it("does NOT treat a racer's VERSION-ONLY refresh as a diverged snapshot — the parked declare commits on its FIRST attempt", async () => {
    // THE ARM THAT PINS T2.6'S LOAD-BEARING SCOPING DECISION. The divergence
    // sentinel exists to keep an EVENT's payload honest — it must fire when the
    // CAPABILITY snapshot moved under a parked declare. `cliVersion` is not a
    // capability, so the in-prelude re-check reads the snapshot WITHOUT the
    // currency pair (`#snapshot` is deliberately not widened; only `#cachedRead`
    // carries the pair).
    //
    // Fold the pair into `#snapshot` and this arm goes red: the re-check would
    // see the racer's refreshed version, call it divergence, abort a perfectly
    // valid declare, and pay a full retry — a fresh signing-key unseal that can
    // block on a human — over a field no event carries. No other arm in this
    // suite can catch that, because every other racer reuses one version fixture.
    //
    // ATTEMPT COUNT is the discriminator, not the outcome: a single lost race is
    // survivable, so a widened `#snapshot` would still END at `updated` with the
    // same rows. Only the key-read count separates "committed first try" from
    // "diverged, retried, then committed".
    const parkedKeySource = new ParkingDaemonSigningKeySource();
    const { writer: parkedWriter } = makeWriter(makeAdvancingClock(), parkedKeySource, "parked");
    const { writer: racingWriter } = makeWriter(makeAdvancingClock(), undefined, "racer");
    const seedTools: ProviderToolMetadata[] = [{ name: "search", idempotency_class: "idempotent" }];

    // Seed the driver so the parked declare takes the `updated` (not first-
    // declare) branch and therefore actually reaches the in-prelude re-check.
    await racingWriter.declare({
      sessionId: SECOND_SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: seedTools }),
    });

    // The parked declare carries a REAL capability change and stalls in the key
    // unseal, holding only session 1's lock.
    const parkedDeclare = parkedWriter.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({
        capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        tools: seedTools,
      }),
    });
    await parkedKeySource.parkReachedAt(0);

    // The racer changes ONLY the version — same flags, same contractVersion,
    // same tools — so it takes the noop branch and its side-write moves the
    // durable pair under the parked declare's feet.
    const racerOutcome = await racingWriter.declare({
      sessionId: SECOND_SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: seedTools, cliVersion: UPGRADED_CLI_VERSION_REPORT }),
    });
    expect(racerOutcome).toEqual({ emitted: "noop", cliVersionRefreshed: true });
    expect(readCliVersionPair(DRIVER_NAME)?.cli_version_semver).toBe(
      UPGRADED_CLI_VERSION_REPORT.semver,
    );

    parkedKeySource.releaseAt(0);
    const parkedOutcome = await parkedDeclare;

    // (a) It committed as an ordinary update — no divergence, no retry.
    expect(parkedOutcome.emitted).toBe("updated");
    // (b) EXACTLY ONE attempt. This is the assertion a widened `#snapshot`
    // fails.
    expect(parkedKeySource.attemptCount).toBe(1);

    // (c) The pair is LAST-WRITER-WINS: the parked declare's own upsert restated
    // its own (older) reading over the racer's. Documented and accepted — both
    // writers persisted a then-current reading of the same installed build, and
    // the next declare re-converges. Asserted rather than left implicit so the
    // trade-off stays visible if anyone revisits it.
    expect(readCliVersionPair(DRIVER_NAME)).toEqual({
      cli_version_raw: CLI_VERSION_REPORT.raw,
      cli_version_semver: CLI_VERSION_REPORT.semver,
    });
    // (d) …and `cliVersionRefreshed` reports the comparison THIS attempt made
    // against the state it decided on (pre-race: same reading ⇒ `false`), which
    // is exactly the scope the result type documents — a claim about this call's
    // own write, never a global ordering claim.
    expect(parkedOutcome.cliVersionRefreshed).toBe(false);

    // (e) Two capability events across both sessions — the seed and the parked
    // update. The racer's version-only refresh added none.
    expect(readCapabilityEventsAcrossSessions().map((row) => row.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);
  });

  it("exhausts the retry budget loudly, writing nothing, when EVERY attempt loses", async () => {
    // THE EXHAUSTION BRANCH. Both arms above lose exactly ONE race and succeed
    // on the retry, so neither reaches `attempt >= DRIVER_DECLARE_MAX_ATTEMPTS`
    // — they cannot tell a bounded retry from an unbounded one, nor prove that
    // exhaustion refuses rather than committing a stale decision. Here the key
    // source parks once per attempt and the racer commits a fresh snapshot
    // while each attempt is parked.
    //
    // EACH RACER SNAPSHOT MUST DIFFER STRUCTURALLY FROM THE LAST. `declare`
    // compares through `snapshotsEqual`, so a racer that rewrote an equivalent
    // snapshot would not be a divergence at all and the parked attempt would
    // commit — the arm would pass while testing nothing.
    const parkedKeySource = new ParkingDaemonSigningKeySource(DECLARE_ATTEMPT_BUDGET);
    const { writer: parkedWriter } = makeWriter(makeAdvancingClock(), parkedKeySource, "parked");
    const { writer: racingWriter } = makeWriter(makeAdvancingClock(), undefined, "racer");

    const parkedDeclare = parkedWriter.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: makeResult({ tools: [{ name: "loser_tool", idempotency_class: "idempotent" }] }),
    });

    for (let round = 0; round < DECLARE_ATTEMPT_BUDGET; round += 1) {
      await parkedKeySource.parkReachedAt(round);
      await racingWriter.declare({
        sessionId: SECOND_SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ resume: false }), contractVersion: `9.9.${round}` },
          tools: [{ name: `racer_tool_${String(round)}`, idempotency_class: "compensable" }],
        }),
      });
      parkedKeySource.releaseAt(round);
    }

    await expect(parkedDeclare).rejects.toThrow(
      /changed between the read-decide step and the write transaction/,
    );
    await expect(parkedDeclare).rejects.toMatchObject({
      name: "DriverCapabilitySnapshotDivergedError",
    });

    // ALL-OR-NOTHING ACROSS ALL THREE DRIVER TABLES. Every one holds the
    // racer's LAST snapshot and nothing of the loser's: a partial apply here
    // would be flags from one declare, tools from another, and a contract
    // version from a third — a snapshot no `getCapabilities` ever returned.
    expect(countCapabilityRows(DRIVER_NAME)).toBe(DRIVER_CAPABILITY_FLAGS.length);
    expect(readToolNames(DRIVER_NAME)).toEqual([
      `racer_tool_${String(DECLARE_ATTEMPT_BUDGET - 1)}`,
    ]);
    expect(countContractMetaRows(DRIVER_NAME)).toBe(1);
    expect(readContractVersion(DRIVER_NAME)).toBe(`9.9.${String(DECLARE_ATTEMPT_BUDGET - 1)}`);

    // And the loser's session holds no event row at all — no sequence consumed,
    // no `capability_updated` describing a transition that never committed.
    expect(readEventRows(SESSION_ID)).toHaveLength(0);
    expect(readCapabilityEventsAcrossSessions().map((row) => row.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
      "runtime_node.capability_updated",
    ]);
  });
});

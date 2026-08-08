// WorktreeEventEmitter — Plan-010 Phase 2 T2.1.
//
// Exercises the single seam every worktree state transition appends its
// `session_lifecycle` event through, over a real test SQLite DB (same lifecycle
// as the Plan-009 emitter suite this file instantiates for the worktree domain:
// `openDatabase` factory → per-test tmp file → `afterEach` close + unlink), with
// Plan-006's `EventLogService` as the durable append path. A structural block at
// the bottom drives the same emitter through a plain-object log to pin the parts
// of the seam contract a real database cannot show.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Registry anchor: `SESSION_EVENT_CATEGORY_BY_TYPE` maps all five types to
//     `session_lifecycle`. This is what keeps the per-event category assertions
//     below non-circular — the emitter READS that registry, so comparing a
//     persisted row against it proves only propagation until the registry's own
//     contents are pinned once, here.
//   * Per-event persistence: each of the five methods appends exactly ONE row
//     carrying its own type, its registry category, and the schema-parsed
//     payload — including the post-transition state the method determines.
//   * The D-010-12 mapping AS A SET: all five methods driven through one
//     recording log yield exactly the five `{type, state}` pairs the decision
//     names, and no other.
//   * The D-010-11 carve-out, emitter-side: the seam exposes exactly five emit
//     surfaces, no `emitFailed` under either plausible spelling, and no
//     emission carries `state: "failed"` — even though the payload schema
//     deliberately ADMITS that state (it is the row vocabulary). The census
//     absence and union rejection of `worktree.failed` are already pinned in
//     `packages/contracts/src/__tests__/worktree.test.ts`; re-asserting them
//     here would test contracts, not this seam.
//   * Integrity columns: the emitter never computes them, and the append path
//     materializes real ones (a genuine chain hash + daemon signature, not
//     zero-fill), which is the observable form of "this module touches no
//     integrity primitive".
//   * Reconciliation: one `sessionId` / `actor` input populates BOTH the
//     envelope and the payload, and the envelope-only linkage fields stay OUT of
//     the payload.
//   * Subject identification: every emission names its worktree; the two
//     optional associations are present only when the producer supplies them,
//     and ABSENT (not present-and-undefined) when it does not.
//   * Emission boundary: a payload the family schema refuses makes the emit
//     throw BEFORE the append, so nothing is persisted — the `.parse()` seam is
//     a true gate, not a post-hoc check. Including the subject-id floor: a
//     compiler-bypassed missing `worktreeId` is refused at RUNTIME by the seam's
//     own brand-parse, which the family schema (where the field is optional)
//     would have let through as a subjectless row.
//   * Determinism: injected `now` / `newEventId` flow through to the persisted
//     row and the receipt, and the DEFAULT id source is unique per emit (a
//     constant would collide on the primary key).
//   * Seam contract: the emitter names no concrete storage class, forwards a
//     caller's `transactionalPrelude` verbatim and WITHOUT invoking it itself
//     (the invocation count is what separates forwarding from double-applying
//     the producer's row write) — and against the real append path a THROWING
//     prelude aborts before the INSERT, so no row persists,
//     which is the transactional half of I-010-13 — admits any thenable,
//     propagates a rejecting append unchanged, and refuses a synchronous append
//     at both layers (the compile-time `Promise` return, pinned by a
//     `@ts-expect-error` control, plus the runtime fail-closed tripwire).
//
// One arm is deliberately ABSENT: there is no "rejects an out-of-vocabulary
// state" test, because the emitter accepts no state to reject. Each method
// derives its own from the type it emits, so the malformed-state case is
// unrepresentable rather than merely refused — pinned by the compile-time
// control below instead. The schema's own state vocabulary is
// `packages/contracts/src/__tests__/worktree.test.ts`'s beat, and asserting it
// from here would test contracts, not this seam.
//
// Spec coverage: `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
// (the five `worktree.*` event types and their shared payload shape);
// `Spec-010 §Resolved Questions and V1 Scope Decisions` (worktree and
// ephemeral-clone transitions are not separately evented beyond the registered
// worktree lifecycle events — the `failed` transition surfaces through the
// owning workspace's `workspace.stale`, and the registry stays closed);
// `Spec-010 §State And Data Implications` (the `worktrees` rows whose
// transitions these events witness).
// Verifies invariant: I-010-13 (emitter-side half: one emit, one row, with the
// method-determined state; the prelude commits the row write inside the append
// transaction; `failed` and clone transitions have no surface to emit through.
// The producer-side "every transition" quantifier rides T2.2 — this suite
// constructs no producer, so that half is closed by T2.6's acceptance walk
// rather than here).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  WorktreeLifecyclePayloadSchema,
} from "@ai-sidekicks/contracts";
import type { SessionEventType, SessionId, WorktreeState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import type {
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import type {
  EmitWorktreeEventInput,
  WorktreeEventEmitterDeps,
  WorktreeEventLog,
} from "../worktree-event-emitter.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// All four ids are validated through branded UUID schemas at the emission
// boundary, so the fixtures must be real UUIDs — not arbitrary opaque scalars.
const SESSION_ID: string = "0190f8b0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const WORKTREE_ID: string = "0190f8b1-1c3d-7e6a-8f21-2c7d6b4e9a10";
const REPO_MOUNT_ID: string = "0190f8b2-2d4e-7f7b-9a32-3d8e7c5f0b21";
const WORKSPACE_ID: string = "0190f8b3-3e5f-7a8c-8b43-4e9f8d60c132";
// `actor` is the free-form envelope actor string (a bounded audit scalar), NOT
// a branded id — any bounded non-blank string is valid.
const PARTICIPANT_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The integrity-column widths the `session_events` CHECK constraints enforce.
// The emitter never writes them; the arm below asserts the append path
// materialized REAL ones.
const CHAIN_HASH_LEN: number = 32;
const DAEMON_SIGNATURE_LEN: number = 64;

// The five types this emitter owns. `SessionEventType`-annotated so a literal
// that left the census fails this file's compile rather than silently asserting
// against a name nothing registers — which is also why `worktree.failed` can
// appear NOWHERE in this list: it is not a census member (D-010-11).
const WORKTREE_EVENT_TYPES: readonly SessionEventType[] = [
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
];

// The D-010-12 mapping, restated INDEPENDENTLY of the emitter's own table (the
// emitter reads its private `WORKTREE_STATE_BY_EVENT_NAME`; this file spells the
// decision out), so a mis-keyed table entry fails here rather than being
// confirmed by its own source. The `WorktreeState` annotation binds the state
// half to the contract enum — and `"failed"` is deliberately absent from every
// row, which is the mapping half of the carve-out.
const D_010_12_MAPPING: ReadonlyArray<readonly [SessionEventType, WorktreeState]> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

/**
 * A fixed-key {@link DaemonSigningKeySource} — enough for an EMISSION suite
 * (`signing-key-source.test.ts` owns key custody). A 32-byte Ed25519 seed;
 * `create` is unreachable here because these tests only ever sign.
 */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(9) as Ed25519PrivateKey;

class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = FIXED_DAEMON_PRIVATE_KEY;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    // Never called: this suite signs against a pre-existing key. Throwing keeps
    // an accidental provisioning call loud instead of returning a fake public
    // key that would silently pass an assertion.
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

// Raw read shape — the integrity columns are not exposed by any read model.
interface LifecycleRow {
  readonly sequence: bigint;
  readonly type: string;
  readonly category: string;
  readonly version: string;
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly payload: string;
  readonly prev_hash: Buffer;
  readonly row_hash: Buffer;
  readonly daemon_signature: Buffer;
}

function readRawRows(db: DatabaseType, sessionId: string): ReadonlyArray<LifecycleRow> {
  return db
    .prepare(
      `SELECT sequence, type, category, version, actor, occurred_at, monotonic_ns,
              payload, prev_hash, row_hash, daemon_signature
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .safeIntegers(true)
    .all(sessionId) as ReadonlyArray<LifecycleRow>;
}

// A deterministic, COLLISION-FREE id source: a constant id would violate the
// `TEXT PRIMARY KEY` on the second emit, so tests that emit more than once
// inject this counter.
function makeCounterIdSource(prefix: string): () => string {
  let counter: number = 0;
  return () => `${prefix}-${(counter++).toString()}`;
}

/**
 * The `state` an envelope's payload carries, read structurally. The envelope
 * types `payload` as `Record<string, unknown>` (the version-tolerant carrier),
 * so reading the field back needs one narrow — hoisted here rather than
 * repeated inline at every assertion site.
 */
function payloadState(envelope: UnsequencedEventEnvelope): unknown {
  return (envelope.payload as { state?: unknown }).state;
}

/**
 * A plain-object append seam that records what it was handed and hands back a
 * receipt of its own. Proves the emitter names no concrete storage class, and
 * gives the envelope-level assertions a view no SQL query offers (the
 * correlation pair's ABSENCE, for one).
 */
function recordingEventLog(appended: UnsequencedEventEnvelope[]): WorktreeEventLog {
  return {
    append: (envelope) => {
      appended.push(envelope);
      return Promise.resolve({
        id: envelope.id,
        sequence: appended.length - 1,
        rowHash: new Uint8Array(32),
      });
    },
  };
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  eventLog: EventLogService;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-emitter-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // Canonical factory — same open semantics (pragmas + migrations) as
  // production. No session or worktree row is seeded: `session_events` carries
  // no foreign key to either, so emitting against bare ids is valid, exactly as
  // the existing append suites do.
  const db: DatabaseType = openDatabase(dbPath);
  ctx = {
    db,
    eventLog: new EventLogService({
      db,
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
    tmpDir,
  };
});

afterEach(() => {
  // The per-session append lock is a MODULE SINGLETON, so a case that left a
  // queue entry behind would stall the next case touching the same session id —
  // and the failure would present as an unrelated timeout. Reset between cases,
  // never during one.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(overrides: Partial<WorktreeEventEmitterDeps> = {}): WorktreeEventEmitter {
  return new WorktreeEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

/**
 * Read back the single row an emit is expected to have appended, asserting the
 * "exactly once" half of I-010-13 plus the envelope fields every one of the five
 * carries. The category comes from the registry rather than a literal — the
 * anchor test above is what stops that from being circular.
 */
function readSingleRow(expectedType: SessionEventType): LifecycleRow {
  const rows: ReadonlyArray<LifecycleRow> = readRawRows(ctx.db, SESSION_ID);
  expect(rows).toHaveLength(1);
  const row: LifecycleRow | undefined = rows[0];
  if (row === undefined) {
    throw new Error("expected exactly one persisted worktree lifecycle row");
  }
  expect(row.type).toBe(expectedType);
  expect(row.category).toBe(SESSION_EVENT_CATEGORY_BY_TYPE.get(expectedType));
  expect(row.version).toBe("1.0");
  return row;
}

/**
 * Assert the persisted payload BOTH matches the literal shape Spec-006 mandates
 * and equals what the family schema itself returns for that input.
 *
 * The literal comparison is the load-bearing one: `toEqual` fails on a missing
 * key AND on an extra one, so an envelope-only field leaking into the payload —
 * or a state that is not the emitting method's — breaks it. The schema
 * comparison is identical TODAY, because the family schema normalizes nothing
 * (its branded-UUID parsers are pure validators and its actor parser does not
 * trim) — and on a CANONICAL fixture it would stay identical even after a
 * normalizer landed, since normalization is the identity on canonical input. The
 * tripwire is therefore only live where a fixture is deliberately non-canonical:
 * the whitespace-padded-actor arm below is that fixture, and the day a parser
 * starts normalizing, its literal comparison fails and the schema comparison
 * names the NORMALIZED value the emitter must persist instead.
 */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(WorktreeLifecyclePayloadSchema.parse(expected));
}

// ----------------------------------------------------------------------------
// Registry anchor — the fact every category assertion below leans on
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — category registry anchor", () => {
  it("registers all five worktree lifecycle types under session_lifecycle", () => {
    expect(WORKTREE_EVENT_TYPES.map((type) => SESSION_EVENT_CATEGORY_BY_TYPE.get(type))).toEqual([
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
    ]);
  });
});

// ----------------------------------------------------------------------------
// One method per event type — exactly one row, right type, right category,
// schema-parsed payload, method-determined state (I-010-13, D-010-12)
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — per-event emission", () => {
  it("emitWorktreeCreated appends one worktree.created row in state creating", async () => {
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.created"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "creating",
      actor: PARTICIPANT_ID,
    });
  });

  it("emitWorktreeReady appends one worktree.ready row in state ready", async () => {
    await makeEmitter().emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.ready"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "ready",
      // A system-driven transition: absent input actor narrows to null, the
      // wire form for "no participant or agent did this".
      actor: null,
    });
  });

  it("emitWorktreeDirty appends one worktree.dirty row in state dirty", async () => {
    await makeEmitter().emitWorktreeDirty({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.dirty"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "dirty",
      actor: null,
    });
  });

  it("emitWorktreeMerged appends one worktree.merged row in state merged", async () => {
    await makeEmitter().emitWorktreeMerged({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.merged"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "merged",
      actor: null,
    });
  });

  it("emitWorktreeRetired appends one worktree.retired row in state retired", async () => {
    await makeEmitter().emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.retired"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: PARTICIPANT_ID,
    });
  });

  it("takes no state from the caller — the method determines it", async () => {
    // BOTH halves of the "unrepresentable, not merely rejected" claim in one
    // case. Compile-time: `state` is not a member of the input, so the literal
    // below is an excess property. Deleting the directive must yield that
    // excess-property error, never an unused-directive TS2578.
    await makeEmitter().emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      // @ts-expect-error — callers cannot pair a type with a state D-010-12
      // does not give it.
      state: "dirty",
    });

    // Runtime: a state forced past the compiler is not read at all. The
    // persisted state is the one `emitWorktreeRetired` owns, so the seam cannot
    // be talked into writing a row that lies about its own transition.
    expectPersistedPayload(readSingleRow("worktree.retired"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: null,
    });
  });

  it("persists a whitespace-padded actor VERBATIM — the family schema normalizes nothing", async () => {
    // The one deliberately NON-canonical fixture in the file, and the arm that
    // keeps `expectPersistedPayload`'s literal-vs-parsed pair discriminating
    // (see its doc comment): "  alice  " is accepted today — the actor regex
    // requires only one non-whitespace character and no parser trims — so both
    // comparisons pass. The day a `.trim()` lands in the actor parser, the
    // literal comparison here fails and the schema comparison names the
    // normalized value the emitter must persist instead.
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: "  alice  ",
    });

    expectPersistedPayload(readSingleRow("worktree.created"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "creating",
      actor: "  alice  ",
    });
  });
});

// ----------------------------------------------------------------------------
// The D-010-12 mapping as a SET, and the D-010-11 carve-out, emitter-side
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — D-010-12 mapping and the D-010-11 carve-out", () => {
  it("emits exactly the five mapped {type, state} pairs across all five methods", async () => {
    // The per-event arms above each prove ONE pairing against a persisted row.
    // This one proves the mapping as a whole, through a recording log so all
    // five fit in a single ordered comparison. A future sixth method, a
    // mis-keyed table entry, or a method silently re-using another's state
    // fails here even when every individual row still parses.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("mapping"),
    });
    // Annotated, not inferred: a shared literal driven through five methods is
    // exactly where excess-property checking earns its keep — an inferred
    // `{ sessionId, worktreeId }` would silently accept a stray key (a
    // hand-supplied `state`, say) that the annotation refuses at the literal.
    const input: EmitWorktreeEventInput = { sessionId: SESSION_ID, worktreeId: WORKTREE_ID };

    await emitter.emitWorktreeCreated(input);
    await emitter.emitWorktreeReady(input);
    await emitter.emitWorktreeDirty(input);
    await emitter.emitWorktreeMerged(input);
    await emitter.emitWorktreeRetired(input);

    const emittedPairs = appended.map((envelope) => [envelope.type, payloadState(envelope)]);
    expect(emittedPairs).toEqual(D_010_12_MAPPING);
  });

  it("never emits state `failed`, though the payload schema admits it", async () => {
    // The discriminating fact: `failed` IS a member of `WorktreeState` and the
    // family payload parses it clean (worktree.ts — "FIVE OF THE SIX STATES
    // appear on the wire"), so nothing downstream of this seam would refuse a
    // `worktree.retired` carrying `state: "failed"`. What makes the `-> failed`
    // transition unevented is that no method here resolves to that state
    // (D-010-11 / I-010-13); the failure incident is evented as
    // `workspace.stale` by the coupled `failReprovision` instead.
    const failedStatePayload = WorktreeLifecyclePayloadSchema.safeParse({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "failed",
    });
    expect(failedStatePayload.success).toBe(true);

    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("no-failed"),
    });
    const input: EmitWorktreeEventInput = { sessionId: SESSION_ID, worktreeId: WORKTREE_ID };

    await emitter.emitWorktreeCreated(input);
    await emitter.emitWorktreeReady(input);
    await emitter.emitWorktreeDirty(input);
    await emitter.emitWorktreeMerged(input);
    await emitter.emitWorktreeRetired(input);

    // Non-vacuity first: `not.toContain` passes on an EMPTY array, so the two
    // negative assertions below mean "no `failed` among five real emissions"
    // only once the count is pinned.
    expect(appended).toHaveLength(5);
    expect(appended.map(payloadState)).not.toContain("failed");
    expect(appended.map((envelope) => envelope.type)).not.toContain("worktree.failed");
  });

  it("exposes exactly five emit surfaces and nothing named for failure", () => {
    // The public method census. `#private` methods do not appear on the
    // prototype's own property names, so this list IS the seam's surface —
    // a sixth emit method (or a clone one) fails the equality, and the
    // name filter catches a failure surface added under any spelling.
    const prototypeNames: readonly string[] = Object.getOwnPropertyNames(
      WorktreeEventEmitter.prototype,
    );
    const methodNames: readonly string[] = prototypeNames.filter((name) => name !== "constructor");

    expect([...methodNames].sort()).toEqual([
      "emitWorktreeCreated",
      "emitWorktreeDirty",
      "emitWorktreeMerged",
      "emitWorktreeReady",
      "emitWorktreeRetired",
    ]);
    expect(methodNames.filter((name) => /fail/i.test(name))).toEqual([]);
    expect(methodNames.filter((name) => /clone/i.test(name))).toEqual([]);
  });

  it("has no failed-transition emit surface at COMPILE time, under either spelling", () => {
    // The census above is a runtime enumeration; this is the compile-time half,
    // and it pins BOTH plausible names — the plan's literal `emitFailed` and the
    // subject-prefixed `emitWorktreeFailed` this file's naming would suggest —
    // so the pin cannot miss on a naming choice. Deleting either directive must
    // yield a property-does-not-exist error (TS2339), never an unused-directive
    // TS2578. The runtime assertions are the second layer: an emit surface that
    // existed but was, say, inherited rather than own-enumerable would satisfy
    // the census above and fail here.
    const emitter: WorktreeEventEmitter = makeEmitter();

    // @ts-expect-error — there is no `emitWorktreeFailed`: the `-> failed`
    // transition emits no worktree event (D-010-11 / I-010-13).
    const worktreeFailedSurface: unknown = emitter.emitWorktreeFailed;
    // @ts-expect-error — nor under the plan's own spelling, `emitFailed`.
    const failedSurface: unknown = emitter.emitFailed;

    expect(worktreeFailedSurface).toBeUndefined();
    expect(failedSurface).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Integrity primitives — materialized by the append path, never by the emitter
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — integrity columns and monotonic_ns", () => {
  it("persists the injected monotonic_ns and REAL integrity columns it never computed", async () => {
    await makeEmitter({ monotonicNow: () => 11_000_000_000n }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    expect(row.monotonic_ns).toBe(11_000_000_000n);

    // Exact CHECK-constraint widths, written by the append path.
    expect(row.prev_hash.length).toBe(CHAIN_HASH_LEN);
    expect(row.row_hash.length).toBe(CHAIN_HASH_LEN);
    expect(row.daemon_signature.length).toBe(DAEMON_SIGNATURE_LEN);

    // `prev_hash` IS all-zero here, for the opposite of a placeholder reason:
    // this is the session's FIRST row, so its chain link is the genesis value.
    // The two columns a non-computing writer would ALSO have left zero are the
    // discriminating ones, and both are asserted NON-zero — which is what
    // proves the emitter delegated rather than filled them in.
    expect(row.prev_hash.equals(Buffer.alloc(CHAIN_HASH_LEN))).toBe(true);
    expect(row.row_hash.equals(Buffer.alloc(CHAIN_HASH_LEN))).toBe(false);
    expect(row.daemon_signature.equals(Buffer.alloc(DAEMON_SIGNATURE_LEN))).toBe(false);
  });

  it("lets the append path allocate every sequence — successive emits advance it", async () => {
    const emitter: WorktreeEventEmitter = makeEmitter();
    const created: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    // The receipts report what the append path ASSIGNED, and the rows agree —
    // no sequence this emitter invented.
    expect([created.sequence, ready.sequence]).toEqual([0, 1]);
    expect(readRawRows(ctx.db, SESSION_ID).map((row) => row.sequence)).toEqual([0n, 1n]);
  });
});

// ----------------------------------------------------------------------------
// Envelope/payload reconciliation and subject identification
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — envelope/payload reconciliation", () => {
  it("populates the envelope and the payload from ONE sessionId and actor input", async () => {
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: PARTICIPANT_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    // The row's own actor column IS the payload's actor, and the row lives under
    // the session the payload names — a caller has no second input with which to
    // make the two disagree.
    expect(row.actor).toBe(PARTICIPANT_ID);
    expect(persisted["actor"]).toBe(PARTICIPANT_ID);
    expect(persisted["sessionId"]).toBe(SESSION_ID);
  });

  it("keeps the envelope-only linkage fields out of the payload", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      correlationId: "corr-1",
      causationId: "cause-1",
    });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope?.correlationId).toBe("corr-1");
    expect(envelope?.causationId).toBe("cause-1");
    // The payload is the FAMILY shape and nothing else: correlation and
    // causation are envelope linkage, and a payload carrying copies of them
    // would be schema drift the strict parse would refuse anyway.
    expect(envelope?.payload).toEqual({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: null,
    });
  });

  it("omits the correlation pair entirely when the caller supplies none", async () => {
    // Negative control for the arm above. `EventEnvelope` types the pair
    // optional and NOT nullable, so absent — not present-and-null — is the
    // no-value wire state.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorktreeReady({ sessionId: SESSION_ID, worktreeId: WORKTREE_ID });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope).toBeDefined();
    expect(Object.hasOwn(envelope ?? {}, "correlationId")).toBe(false);
    expect(Object.hasOwn(envelope ?? {}, "causationId")).toBe(false);
  });

  it("names the full subject context when the producer carries it", async () => {
    // The shape contracts' own worktree fixture models: the worktree id always,
    // plus the mount the checkout belongs to and the workspace its root serves.
    // Legitimately multi-id, which is why the family payload has no
    // "exactly one id" refinement.
    await makeEmitter().emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.ready"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
      state: "ready",
      actor: PARTICIPANT_ID,
    });
  });

  it("omits the optional associations when the producer carries neither", async () => {
    // Negative control for the arm above, and it matters more here than in the
    // Plan-009 precedent because there are TWO optional associations: a
    // present-but-undefined key would be as wrong as a populated one, since
    // which ids a payload carries is how a reader attributes the event. The
    // `worktreeId` floor is what every emission still guarantees.
    await makeEmitter().emitWorktreeDirty({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.dirty");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "repoMountId")).toBe(false);
    expect(Object.hasOwn(persisted, "workspaceId")).toBe(false);
    expect(persisted["worktreeId"]).toBe(WORKTREE_ID);
  });

  it("carries one association without inventing the other", async () => {
    // The worktree service's create seam holds `repoMountId` and no
    // `workspaceId` — the association that lives one layer up — so this is the
    // shape its emissions actually take. The absent workspace key must stay
    // absent rather than being back-filled from anywhere.
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(persisted["repoMountId"]).toBe(REPO_MOUNT_ID);
    expect(Object.hasOwn(persisted, "workspaceId")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Emission boundary — the family schema's `.parse()` is a true gate
// ----------------------------------------------------------------------------
//
// Every case below but the LAST is reachable with a TYPE-VALID input: these
// exercise the runtime `.parse()`, not a TypeScript error. Each asserts BOTH the
// rejection and that nothing was persisted — a schema that ran after the append
// would pass the first half and fail the second.
//
// The final arm is the deliberate exception: it forces a shape the input
// interface forbids, because the guarantee it pins — `worktreeId` is refused at
// RUNTIME, not merely required by the compiler — exists precisely for a producer
// wired past the compiler.

describe("WorktreeEventEmitter — emission-boundary rejection", () => {
  it("rejects a non-UUID worktreeId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-UUID repoMountId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeReady({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        repoMountId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-UUID workspaceId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeMerged({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a malformed sessionId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeDirty({
        sessionId: "session-1",
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, "session-1")).toHaveLength(0);
  });

  it("rejects a whitespace-only actor and appends nothing", async () => {
    // The family payload's actor is a wire free-form string: blank is a producer
    // bug, not a system actor (that is `null` or an absent key). Only
    // ALL-whitespace is blank — padding around content (`"  alice  "`) passes,
    // and the padded-actor arm above proves it persists verbatim.
    await expect(
      makeEmitter().emitWorktreeRetired({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        actor: "   ",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects an over-length actor and appends nothing", async () => {
    // 257 chars trips the payload actor's 256-char cap — the same bound the
    // envelope's own actor carries, so a value accepted here could never be
    // rejected one layer down.
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        actor: "a".repeat(257),
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a compiler-bypassed missing worktreeId and appends nothing", async () => {
    // The subject-id floor, as a RUNTIME guarantee. The family payload schema
    // types `worktreeId` optional — subject-id presence is per-type emitter
    // discipline, not a family shape rule — so this input parses clean through
    // that schema alone and would persist a SUBJECTLESS `worktree.created` row
    // that no reader could attribute to a worktree. The seam's own
    // `WorktreeIdSchema.parse` is what refuses it, and this arm is what fails if
    // that line is ever dropped as "already enforced by the interface": the
    // cast is exactly the shape a plain-JS producer presents.
    const subjectless = { sessionId: SESSION_ID } as unknown as EmitWorktreeEventInput;

    await expect(makeEmitter().emitWorktreeCreated(subjectless)).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Determinism — injected clock + id flow through to the persisted row
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", async () => {
    // Canonical RFC 3339 UTC milliseconds on purpose: the append path normalizes
    // non-canonical timestamps, so only a canonical fixture asserts the INJECTED
    // value flowed through verbatim.
    const FIXED_MONOTONIC: bigint = 8_484_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-08-05T10:30:00.000Z";
    const FIXED_EVENT_ID: string = "evt-worktree-deterministic-0";

    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: ctx.eventLog,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    // The receipt echoes the injected id source; the clocks are asserted on the
    // persisted row — the surface a verifier reads. An emitter that ignored the
    // injected deps and called the production sources directly would pass every
    // other arm in this file; this one is what fails.
    expect(returned.id).toBe(FIXED_EVENT_ID);

    const row: LifecycleRow = readSingleRow("worktree.created");
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", async () => {
    // No `newEventId` override → the production `crypto.randomUUID()` default.
    // Two emits must land two rows with DISTINCT ids — this is what pins the dep
    // comment's claim that a CONSTANT id would collide on the TEXT PRIMARY KEY
    // across successive emits.
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: ctx.eventLog,
    });

    const first: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const second: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(first.id).not.toBe(second.id);
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// WorktreeEventLog seam — structural arms against plain-object logs, plus the
// one real-append arm the structural set cannot carry (prelude abort).
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — WorktreeEventLog seam", () => {
  it("emits through a plain-object log implementation (no EventLogService, no database)", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("structural"),
    });

    const created: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(appended).toHaveLength(2);
    expect(appended[0]?.type).toBe("worktree.created");
    expect(appended[1]?.type).toBe("worktree.ready");
    // The emitter surfaced the seam's assigned sequences verbatim — it invented
    // neither.
    expect([created.sequence, ready.sequence]).toEqual([0, 1]);
  });

  it("forwards a caller-supplied transactionalPrelude verbatim and never runs it", async () => {
    // The prelude is how the `worktrees` row write commits atomically with its
    // event — the transactional half of I-010-13. This emitter's job is to
    // FORWARD it, not to wrap, re-order, or invoke it, so the assertions are
    // identity AND a zero invocation count: anything done to the closure would
    // break the atomicity the append path provides around it. The count is what
    // separates "forwards it" from "forwards it AND runs it" — the capturing
    // log below never invokes what it captures, so the only thing that could
    // move the counter is the emitter itself, which would apply T2.2's row
    // write twice (once here, OUTSIDE any transaction, and once inside the real
    // append path's).
    const forwardedOptions: Array<{ transactionalPrelude?: () => void }> = [];
    const capturingEventLog: WorktreeEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push(options ?? {});
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };
    let preludeInvocations: number = 0;
    const prelude = (): void => {
      preludeInvocations += 1;
    };

    await new WorktreeEventEmitter({ sessionEvents: capturingEventLog }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      transactionalPrelude: prelude,
    });

    expect(forwardedOptions).toHaveLength(1);
    expect(forwardedOptions[0]?.transactionalPrelude).toBe(prelude);
    expect(preludeInvocations).toBe(0);
  });

  it("omits transactionalPrelude entirely when the caller supplies none", async () => {
    // Negative control for the arm above: the KEY is absent, not
    // present-and-undefined.
    const forwardedOptions: Array<Record<string, unknown>> = [];
    const capturingEventLog: WorktreeEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push((options ?? {}) as Record<string, unknown>);
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };

    await new WorktreeEventEmitter({ sessionEvents: capturingEventLog }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(forwardedOptions[0]).toBeDefined();
    expect(Object.hasOwn(forwardedOptions[0] ?? {}, "transactionalPrelude")).toBe(false);
  });

  it("aborts the append when the forwarded prelude throws against the real path — no row persists", async () => {
    // The identity arms above prove the closure REACHES the options object; this
    // arm proves the mechanism I-010-13's "transactionally with the row write"
    // rests on: against the real append path the prelude runs INSIDE the
    // transaction, so its throw aborts before the INSERT and the failure
    // surfaces to the producer. An emitter that wrapped, deferred, or invoked
    // the prelude itself already fails the identity/invocation arms above; one
    // that swallowed the append rejection, or whose forwarding stopped reaching
    // the real transaction boundary, passes those and fails HERE. (The positive
    // control, a prelude whose `worktrees` write commits atomically with the
    // row, ships with T2.2, the first real dual-write producer.)
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        transactionalPrelude: () => {
          throw new Error("prelude divergence");
        },
      }),
    ).rejects.toThrow("prelude divergence");
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a synchronous append at COMPILE time (Promise return, not undefined)", async () => {
    // Layer 1 of the seam contract, pinned: `undefined` is not assignable to
    // `Promise<EventLogAppendReceipt>`, so the synchronous shape fails the
    // assignment. Deleting the directive below must yield that underlying
    // assignment error — an unused-directive TS2578 here would mean the
    // compile-time layer silently regressed to accepting synchronous appenders.
    const compileRejectedEventLog: WorktreeEventLog = {
      // @ts-expect-error — a synchronous `append` (returns `undefined`) does not
      // satisfy `append(envelope, options): Promise<EventLogAppendReceipt>`.
      append: (): undefined => undefined,
    };
    // The object still exists at runtime; the runtime tripwire covers it.
    await expect(
      new WorktreeEventEmitter({ sessionEvents: compileRejectedEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow(/did not return a promise/);
  });

  it("refuses a non-thenable append fail-closed", async () => {
    // The seam is ASYNC-transactional by contract, and the compile-time layer is
    // its `Promise` return type — so reaching the runtime tripwire at all
    // requires wiring the compiler never saw, which the cast below models. A
    // synchronous append would report success before the write is durable and
    // would never commit the caller's prelude atomically with the row.
    const appendCalls: UnsequencedEventEnvelope[] = [];
    const syncEventLog: WorktreeEventLog = {
      append: (envelope): Promise<EventLogAppendReceipt> => {
        appendCalls.push(envelope);
        return undefined as unknown as Promise<EventLogAppendReceipt>;
      },
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: syncEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow(/did not return a promise[\s\S]*transactionalPrelude/);

    // Tripwire, not prevention: the implementation has already run by the time
    // the non-promise comes back. The guard's job is to be LOUD on the first
    // emit, not to undo that work.
    expect(appendCalls).toHaveLength(1);
  });

  it("admits a custom thenable (duck-typed, not instanceof Promise)", async () => {
    // Positive control for the guard's duck test: `await` latches onto ANY
    // `then` function, so the guard must too — an `instanceof Promise` check
    // would reject a valid async implementation built on a userland promise or a
    // wrapper, a false positive on the fail-closed side. A regression to
    // `instanceof` leaves every other arm green (their fakes return real
    // Promises); this one is what fails.
    const receipt: EventLogAppendReceipt = { id: "x", sequence: 3, rowHash: new Uint8Array(32) };
    const customThenableEventLog: WorktreeEventLog = {
      append: (): Promise<EventLogAppendReceipt> =>
        ({
          then: (resolve?: (value: EventLogAppendReceipt) => void) => resolve?.(receipt),
        }) as unknown as Promise<EventLogAppendReceipt>,
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: customThenableEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).resolves.toEqual(receipt);
  });

  it("propagates a REJECTING append unchanged", async () => {
    // The failure channel a producer learns from: its durable write did not
    // commit. The emitter awaits, so the rejection reaches the caller verbatim
    // rather than becoming a fire-and-forget that reported success.
    const rejectingEventLog: WorktreeEventLog = {
      append: (): Promise<EventLogAppendReceipt> => Promise.reject(new Error("append lock lost")),
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: rejectingEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow("append lock lost");
  });
});

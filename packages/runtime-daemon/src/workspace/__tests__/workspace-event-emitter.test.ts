// WorkspaceEventEmitter — Plan-009 Phase 2.
//
// Exercises the single seam every repo-mount / workspace state transition
// appends its `session_lifecycle` event through, over a real test SQLite DB
// (same lifecycle as the neighbouring emitter suite: `openDatabase` factory →
// per-test tmp file → `afterEach` close + unlink), with Plan-006's
// `EventLogService` as the durable append path. A structural block at the
// bottom drives the same emitter through a plain-object log to pin the parts
// of the seam contract a real database cannot show.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Registry anchor: `SESSION_EVENT_CATEGORY_BY_TYPE` maps all six types to
//     `session_lifecycle`. This is what keeps the per-event category
//     assertions below non-circular — the emitter READS that registry, so
//     comparing a persisted row against it proves only propagation until the
//     registry's own contents are pinned once, here.
//   * Per-event persistence: each of the six methods appends exactly ONE row
//     carrying its own type, its registry category, and the schema-parsed
//     payload — including the post-transition state the method determines.
//   * Integrity columns: the emitter never computes them, and the append path
//     materializes real ones (a genuine chain hash + daemon signature, not
//     zero-fill), which is the observable form of "this module touches no
//     integrity primitive".
//   * Reconciliation: one `sessionId` / `actor` input populates BOTH the
//     envelope and the payload, and the envelope-only linkage fields stay OUT
//     of the payload.
//   * Subject identification: a workspace event names its workspace, and it
//     names a mount only when its producer supplies the association — the
//     birth events and the detach cascade's `workspace.archived` both do.
//   * Emission boundary: a payload the family schema refuses makes the emit
//     throw BEFORE the append, so nothing is persisted — the `.parse()` seam
//     is a true gate, not a post-hoc check.
//   * Determinism: injected `now` / `newEventId` flow through to the
//     persisted row and the receipt, and the DEFAULT id source is unique per
//     emit (a constant would collide on the primary key).
//   * Seam contract: the emitter names no concrete storage class, forwards a
//     caller's `transactionalPrelude` verbatim — and against the real append
//     path a THROWING prelude aborts before the INSERT, so no row persists —
//     admits any thenable, propagates a rejecting append unchanged, and
//     refuses a synchronous append at both layers (the compile-time `Promise`
//     return, pinned by a `@ts-expect-error` control, plus the runtime
//     fail-closed tripwire).
//
// One arm is deliberately ABSENT: there is no "rejects an out-of-vocabulary
// state" test, because the emitter accepts no state to reject. Each method
// derives its own from the type it emits, so the malformed-state case is
// unrepresentable rather than merely refused — pinned by the compile-time
// control below instead. The schema's own state vocabulary is `repo.test.ts`'s
// beat, and asserting it from here would test contracts, not this seam.
//
// Spec coverage: `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
// (the six event types and their shared payload shape);
// `Spec-009 §State And Data Implications` (the rows whose transitions these events witness);
// `Spec-009 §Detach Semantics (V1 Definition)` (the cascade that emits a workspace archival
// naming both a workspace and its mount).
// Verifies invariant: I-009-9 (emitter-side half: one emit, one row, with the
// method-determined state. The producer-side "every transition" quantifier
// rides T2.3/T2.4 — this suite constructs no producer, so that half is closed
// by T2.6's acceptance walk rather than here).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RepoWorkspaceLifecyclePayloadSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
} from "@ai-sidekicks/contracts";
import type { SessionEventType, SessionId } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import type {
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { WorkspaceEventEmitterDeps, WorkspaceEventLog } from "../workspace-event-emitter.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// All three ids are validated through branded UUID schemas at the emission
// boundary, so the fixtures must be real UUIDs — not arbitrary opaque scalars.
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0190f8a1-1c3d-7e6a-8f21-2c7d6b4e9a10";
const WORKSPACE_ID: string = "0190f8a2-2d4e-7f7b-9a32-3d8e7c5f0b21";
// `actor` is the free-form envelope actor string (a bounded audit scalar), NOT
// a branded id — any bounded non-blank string is valid.
const PARTICIPANT_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The integrity-column widths the `session_events` CHECK constraints enforce.
// The emitter never writes them; the arm below asserts the append path
// materialized REAL ones.
const CHAIN_HASH_LEN: number = 32;
const DAEMON_SIGNATURE_LEN: number = 64;

// The six types this emitter owns. `SessionEventType`-annotated so a literal
// that left the census fails this file's compile rather than silently
// asserting against a name nothing registers.
const LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "repo.attached",
  "repo.detached",
  "workspace.provisioning",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
];

/**
 * A fixed-key {@link DaemonSigningKeySource} — enough for an EMISSION suite
 * (`signing-key-source.test.ts` owns key custody). A 32-byte Ed25519 seed;
 * `create` is unreachable here because these tests only ever sign.
 */
const FIXED_DAEMON_PRIVATE_KEY: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

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
 * A plain-object append seam that records what it was handed and hands back a
 * receipt of its own. Proves the emitter names no concrete storage class, and
 * gives the envelope-level assertions a view no SQL query offers (the
 * correlation pair's ABSENCE, for one).
 */
function recordingEventLog(appended: UnsequencedEventEnvelope[]): WorkspaceEventLog {
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
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-workspace-emitter-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // Canonical factory — same open semantics (pragmas + migrations) as
  // production. No session row is seeded: `session_events.session_id` carries
  // no foreign key, so emitting against a bare session id is valid, exactly as
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
  // queue entry behind would stall the next case touching the same session id
  // — and the failure would present as an unrelated timeout. Reset between
  // cases, never during one.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(overrides: Partial<WorkspaceEventEmitterDeps> = {}): WorkspaceEventEmitter {
  return new WorkspaceEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

/**
 * Read back the single row an emit is expected to have appended, asserting the
 * "exactly once" half of I-009-9 plus the envelope fields every one of the six
 * carries. The category comes from the registry rather than a literal — the
 * anchor test above is what stops that from being circular.
 */
function readSingleRow(expectedType: SessionEventType): LifecycleRow {
  const rows: ReadonlyArray<LifecycleRow> = readRawRows(ctx.db, SESSION_ID);
  expect(rows).toHaveLength(1);
  const row: LifecycleRow | undefined = rows[0];
  if (row === undefined) {
    throw new Error("expected exactly one persisted lifecycle row");
  }
  expect(row.type).toBe(expectedType);
  expect(row.category).toBe(SESSION_EVENT_CATEGORY_BY_TYPE.get(expectedType));
  expect(row.version).toBe("1.0");
  return row;
}

/**
 * Assert the persisted payload BOTH matches the literal shape Spec-006
 * mandates and equals what the family schema itself returns for that input.
 *
 * The literal comparison is the load-bearing one: `toEqual` fails on a missing
 * key AND on an extra one, so an envelope-only field leaking into the payload
 * — or a state that is not the emitting method's — breaks it. The schema
 * comparison is identical TODAY, because the family schema normalizes nothing
 * (its branded-UUID parsers are pure validators and its actor parser does not
 * trim) — and on a CANONICAL fixture it would stay identical even after a
 * normalizer landed, since normalization is the identity on canonical input.
 * The tripwire is therefore only live where a fixture is deliberately
 * non-canonical: the whitespace-padded-actor arm below is that fixture, and
 * the day a parser starts normalizing, its literal comparison fails and the
 * schema comparison names the NORMALIZED value the emitter must persist
 * instead.
 */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(RepoWorkspaceLifecyclePayloadSchema.parse(expected));
}

// ----------------------------------------------------------------------------
// Registry anchor — the fact every category assertion below leans on
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — category registry anchor", () => {
  it("registers all six repo-mount / workspace lifecycle types under session_lifecycle", () => {
    expect(LIFECYCLE_EVENT_TYPES.map((type) => SESSION_EVENT_CATEGORY_BY_TYPE.get(type))).toEqual([
      "session_lifecycle",
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
// schema-parsed payload, method-determined state (I-009-9)
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — per-event emission", () => {
  it("emitRepoAttached appends one repo.attached row in state attached", async () => {
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("repo.attached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "attached",
      actor: PARTICIPANT_ID,
    });
  });

  it("emitRepoDetached appends one repo.detached row in state detached", async () => {
    await makeEmitter().emitRepoDetached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("repo.detached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "detached",
      actor: PARTICIPANT_ID,
    });
  });

  it("emitWorkspaceProvisioning appends one workspace.provisioning row in state provisioning", async () => {
    await makeEmitter().emitWorkspaceProvisioning({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.provisioning"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "provisioning",
      // A system-driven transition: absent input actor narrows to null, the
      // wire form for "no participant or agent did this".
      actor: null,
    });
  });

  it("emitWorkspaceReady appends one workspace.ready row in state ready", async () => {
    await makeEmitter().emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.ready"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "ready",
      actor: null,
    });
  });

  it("emitWorkspaceStale appends one workspace.stale row in state stale", async () => {
    await makeEmitter().emitWorkspaceStale({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.stale"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "stale",
      actor: null,
    });
  });

  it("emitWorkspaceArchived appends one workspace.archived row in state archived", async () => {
    await makeEmitter().emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.archived"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "archived",
      actor: PARTICIPANT_ID,
    });
  });

  it("takes no state from the caller — the method determines it", async () => {
    // BOTH halves of the "unrepresentable, not merely rejected" claim in one
    // case. Compile-time: `state` is not a member of the input, so the literal
    // below is an excess property. Deleting the directive must yield that
    // excess-property error, never an unused-directive TS2578.
    await makeEmitter().emitWorkspaceStale({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      // @ts-expect-error — callers cannot pair a type with a state Spec-006
      // does not give it.
      state: "ready",
    });

    // Runtime: a state forced past the compiler is not read at all. The
    // persisted state is the one `emitWorkspaceStale` owns, so the seam cannot
    // be talked into writing a row that lies about its own transition.
    expectPersistedPayload(readSingleRow("workspace.stale"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "stale",
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
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: "  alice  ",
    });

    expectPersistedPayload(readSingleRow("repo.attached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "attached",
      actor: "  alice  ",
    });
  });
});

// ----------------------------------------------------------------------------
// Integrity primitives — materialized by the append path, never by the emitter
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — integrity columns and monotonic_ns", () => {
  it("persists the injected monotonic_ns and REAL integrity columns it never computed", async () => {
    await makeEmitter({ monotonicNow: () => 7_000_000_000n }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    const row: LifecycleRow = readSingleRow("repo.attached");
    expect(row.monotonic_ns).toBe(7_000_000_000n);

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
    const emitter: WorkspaceEventEmitter = makeEmitter();
    const attached: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    // The receipts report what the append path ASSIGNED, and the rows agree —
    // no sequence this emitter invented.
    expect([attached.sequence, ready.sequence]).toEqual([0, 1]);
    expect(readRawRows(ctx.db, SESSION_ID).map((row) => row.sequence)).toEqual([0n, 1n]);
  });
});

// ----------------------------------------------------------------------------
// Envelope/payload reconciliation and subject identification
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — envelope/payload reconciliation", () => {
  it("populates the envelope and the payload from ONE sessionId and actor input", async () => {
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: PARTICIPANT_ID,
    });

    const row: LifecycleRow = readSingleRow("repo.attached");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    // The row's own actor column IS the payload's actor, and the row lives
    // under the session the payload names — a caller has no second input with
    // which to make the two disagree.
    expect(row.actor).toBe(PARTICIPANT_ID);
    expect(persisted["actor"]).toBe(PARTICIPANT_ID);
    expect(persisted["sessionId"]).toBe(SESSION_ID);
  });

  it("keeps the envelope-only linkage fields out of the payload", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
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
      workspaceId: WORKSPACE_ID,
      state: "archived",
      actor: null,
    });
  });

  it("omits the correlation pair entirely when the caller supplies none", async () => {
    // Negative control for the arm above. `EventEnvelope` types the pair
    // optional and NOT nullable, so absent — not present-and-null — is the
    // no-value wire state.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitRepoAttached({ sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope).toBeDefined();
    expect(Object.hasOwn(envelope ?? {}, "correlationId")).toBe(false);
    expect(Object.hasOwn(envelope ?? {}, "causationId")).toBe(false);
  });

  it("names both ids on a detach-cascade workspace archival", async () => {
    // `Spec-009 §Detach Semantics (V1 Definition)`: a workspace archived
    // BECAUSE its mount detached is the one flow whose payload legitimately
    // carries two ids — a reader holding only the mount would otherwise have
    // no way to attribute the archival.
    await makeEmitter().emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: PARTICIPANT_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.archived"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "archived",
      actor: PARTICIPANT_ID,
    });
  });

  it("omits repoMountId from a workspace payload when the caller names no mount", async () => {
    // The subject of an event is identified by WHICH optional id it carries,
    // so a present-but-undefined key would be as wrong as a populated one:
    // the key must be ABSENT.
    await makeEmitter().emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    const row: LifecycleRow = readSingleRow("workspace.ready");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "repoMountId")).toBe(false);
    expect(Object.hasOwn(persisted, "worktreeId")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Emission boundary — the family schema's `.parse()` is a true gate
// ----------------------------------------------------------------------------
//
// Every case below is reachable with a TYPE-VALID input: these exercise the
// runtime `.parse()`, not a TypeScript error. Each asserts BOTH the rejection
// and that nothing was persisted — a schema that ran after the append would
// pass the first half and fail the second.

describe("WorkspaceEventEmitter — emission-boundary rejection", () => {
  it("rejects a non-UUID repoMountId and appends nothing", async () => {
    await expect(
      makeEmitter().emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-UUID workspaceId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorkspaceReady({
        sessionId: SESSION_ID,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a malformed sessionId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorkspaceProvisioning({
        sessionId: "session-1",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, "session-1")).toHaveLength(0);
  });

  it("rejects a whitespace-only actor and appends nothing", async () => {
    // The family payload's actor is a wire free-form string: blank is a
    // producer bug, not a system actor (that is `null` or an absent key).
    // Only ALL-whitespace is blank — padding around content (`"  alice  "`)
    // passes, and the padded-actor arm above proves it persists verbatim.
    await expect(
      makeEmitter().emitRepoDetached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
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
      makeEmitter().emitWorkspaceArchived({
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        actor: "a".repeat(257),
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Determinism — injected clock + id flow through to the persisted row
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", async () => {
    // Canonical RFC 3339 UTC milliseconds on purpose: the append path
    // normalizes non-canonical timestamps, so only a canonical fixture
    // asserts the INJECTED value flowed through verbatim.
    const FIXED_MONOTONIC: bigint = 4_242_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-08-04T09:15:00.000Z";
    const FIXED_EVENT_ID: string = "evt-deterministic-0";

    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: ctx.eventLog,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    // The receipt echoes the injected id source; the clocks are asserted on
    // the persisted row — the surface a verifier reads. An emitter that
    // ignored the injected deps and called the production sources directly
    // would pass every other arm in this file; this one is what fails.
    expect(returned.id).toBe(FIXED_EVENT_ID);

    const row: LifecycleRow = readSingleRow("repo.attached");
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", async () => {
    // No `newEventId` override → the production `crypto.randomUUID()` default.
    // Two emits must land two rows with DISTINCT ids — this is what pins the
    // dep comment's claim that a CONSTANT id would collide on the TEXT
    // PRIMARY KEY across successive emits.
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: ctx.eventLog,
    });

    const first: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const second: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(first.id).not.toBe(second.id);
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// WorkspaceEventLog seam — structural arms against plain-object logs, plus
// the one real-append arm the structural set cannot carry (prelude abort).
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — WorkspaceEventLog seam", () => {
  it("emits through a plain-object log implementation (no EventLogService, no database)", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("structural"),
    });

    const attached: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(appended).toHaveLength(2);
    expect(appended[0]?.type).toBe("repo.attached");
    expect(appended[1]?.type).toBe("workspace.ready");
    // The emitter surfaced the seam's assigned sequences verbatim — it
    // invented neither.
    expect([attached.sequence, ready.sequence]).toEqual([0, 1]);
  });

  it("forwards a caller-supplied transactionalPrelude to the append verbatim", async () => {
    // The prelude is the producers' dual-write atomicity seam. This emitter's
    // job is to FORWARD it — not to wrap, re-order, or invoke it — so identity
    // is the assertion: anything done to the closure would break the atomicity
    // the append path provides around it.
    const forwardedOptions: Array<{ transactionalPrelude?: () => void }> = [];
    const capturingEventLog: WorkspaceEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push(options ?? {});
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };
    const prelude = (): void => {};

    await new WorkspaceEventEmitter({ sessionEvents: capturingEventLog }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      transactionalPrelude: prelude,
    });

    expect(forwardedOptions).toHaveLength(1);
    expect(forwardedOptions[0]?.transactionalPrelude).toBe(prelude);
  });

  it("omits transactionalPrelude entirely when the caller supplies none", async () => {
    // Negative control for the arm above: the KEY is absent, not
    // present-and-undefined.
    const forwardedOptions: Array<Record<string, unknown>> = [];
    const capturingEventLog: WorkspaceEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push((options ?? {}) as Record<string, unknown>);
        return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
      },
    };

    await new WorkspaceEventEmitter({ sessionEvents: capturingEventLog }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    expect(forwardedOptions[0]).toBeDefined();
    expect(Object.hasOwn(forwardedOptions[0] ?? {}, "transactionalPrelude")).toBe(false);
  });

  it("aborts the append when the forwarded prelude throws against the real path — no row persists", async () => {
    // The identity arms above prove the closure REACHES the options object;
    // this arm proves the mechanism the module header rests I-009-9's
    // dual-write story on: against the real append path the prelude runs
    // INSIDE the transaction, so its throw aborts before the INSERT and the
    // failure surfaces to the producer. A future emitter that wrapped,
    // deferred, or invoked the prelude itself — or swallowed the append
    // rejection — passes the identity arms and fails here. (The positive
    // control, a prelude whose write commits atomically with the row, ships
    // with the first real dual-write producer.)
    await expect(
      makeEmitter().emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
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
    // compile-time layer silently regressed to accepting synchronous
    // appenders.
    const compileRejectedEventLog: WorkspaceEventLog = {
      // @ts-expect-error — a synchronous `append` (returns `undefined`) does
      // not satisfy `append(envelope, options): Promise<EventLogAppendReceipt>`.
      append: (): undefined => undefined,
    };
    // The object still exists at runtime; the runtime tripwire covers it.
    await expect(
      new WorkspaceEventEmitter({ sessionEvents: compileRejectedEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).rejects.toThrow(/did not return a promise/);
  });

  it("refuses a non-thenable append fail-closed", async () => {
    // The seam is ASYNC-transactional by contract, and the compile-time layer
    // is its `Promise` return type — so reaching the runtime tripwire at all
    // requires wiring the compiler never saw, which the cast below models. A
    // synchronous append would report success before the write is durable and
    // would never commit the caller's prelude atomically with the row.
    const appendCalls: UnsequencedEventEnvelope[] = [];
    const syncEventLog: WorkspaceEventLog = {
      append: (envelope): Promise<EventLogAppendReceipt> => {
        appendCalls.push(envelope);
        return undefined as unknown as Promise<EventLogAppendReceipt>;
      },
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: syncEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
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
    // would reject a valid async implementation built on a userland promise
    // or a wrapper, a false positive on the fail-closed side. A regression to
    // `instanceof` leaves every other arm green (their fakes return real
    // Promises); this one is what fails.
    const receipt: EventLogAppendReceipt = { id: "x", sequence: 3, rowHash: new Uint8Array(32) };
    const customThenableEventLog: WorkspaceEventLog = {
      append: (): Promise<EventLogAppendReceipt> =>
        ({
          then: (resolve?: (value: EventLogAppendReceipt) => void) => resolve?.(receipt),
        }) as unknown as Promise<EventLogAppendReceipt>,
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: customThenableEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).resolves.toEqual(receipt);
  });

  it("propagates a REJECTING append unchanged", async () => {
    // The failure channel a producer learns from: its durable write did not
    // commit. The emitter awaits, so the rejection reaches the caller
    // verbatim rather than becoming a fire-and-forget that reported success.
    const rejectingEventLog: WorkspaceEventLog = {
      append: (): Promise<EventLogAppendReceipt> => Promise.reject(new Error("append lock lost")),
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: rejectingEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).rejects.toThrow("append lock lost");
  });
});

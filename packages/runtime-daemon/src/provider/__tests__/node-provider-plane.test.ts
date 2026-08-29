// NodeProviderPlane — the runtime-node lifecycle binder for the capability /
// auth refresh cadence (Plan-005 Phase 3, T3.12 / P2-9's sanctioned wiring
// call).
//
// Coverage targets (audit-derived):
//   * `Spec-005 §Resolved Questions and V1 Scope Decisions` (P2-9) — capability
//     and account-state declarations refresh per runtime node on a bounded
//     periodic cadence. A scheduler nobody STARTS satisfies that on paper only,
//     so the integration case below drives the cadence through the real
//     `NodeRegistry` lifecycle rather than by calling the scheduler directly.
//   * `Spec-005 §Required Behavior` — run admission consumes the per-(node,
//     driver) auth state through this plane's read (`driver.not_authenticated`
//     is the admission seam's refusal, not this module's), and a detached node
//     answers `undefined`, which admission treats fail-closed.
//   * The provider-neutrality boundary: the plane composes a driver's refresh
//     entry from a caller-supplied declaration thunk plus the driver's own
//     `probeAuth`, importing no driver module — asserted here by exercising the
//     composition against a driver double whose `this` must survive the bind.
//
// The unit cases drive a recording scheduler double (a `Pick` of the real
// class, so a signature drift is a compile error here); the integration case
// drives the REAL `CapabilityRefreshScheduler` and the REAL `NodeRegistry` over
// a real test SQLite database, because the property under test is precisely
// that those two are connected.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverAuthProbeResult, SessionId } from "@ai-sidekicks/contracts";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { RuntimeNodeEventEmitter } from "../../node/node-event-emitter.js";
import { NodeRegistry, type RuntimeNodeLifecycleContext } from "../../node/node-registry.js";
import { openDatabase } from "../../session/migration-runner.js";
import {
  CAPABILITY_REFRESH_INTERVAL_MS,
  CapabilityRefreshScheduler,
  type CapabilityRefreshDriverEntry,
  type CapabilityRefreshNodeRegistration,
  type DriverAuthStateRecord,
  type FlooredDriverName,
} from "../capability-refresh.js";
import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import type { DeclareDriverCapabilitiesResult } from "../driver-capabilities-writer.js";
import {
  NodeProviderPlane,
  composeCapabilityRefreshDriverEntry,
  type NodeCapabilityRefreshScheduler,
} from "../node-provider-plane.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// Same identity shapes as the node-registry suite: a UUIDv7 session id (the
// payload schema validates it) and an opaque daemon-minted node id.
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const OTHER_NODE_ID: string = "node-01J0ND1111NN5J5J5J5J5J5J";

const AUTH_RECORD: DriverAuthStateRecord = {
  status: "authenticated",
  observedAtMs: 1_700_000_000_000,
};

/** A recording double of the four scheduler methods the plane drives. */
interface RecordingScheduler {
  readonly scheduler: NodeCapabilityRefreshScheduler;
  readonly started: CapabilityRefreshNodeRegistration[];
  readonly stopped: string[];
  readonly authReads: Array<{ nodeId: string; driverName: string }>;
  readonly shutdowns: number[];
}

function makeRecordingScheduler(): RecordingScheduler {
  const started: CapabilityRefreshNodeRegistration[] = [];
  const stopped: string[] = [];
  const authReads: Array<{ nodeId: string; driverName: string }> = [];
  const shutdowns: number[] = [];
  return {
    scheduler: {
      startForNode: (registration: CapabilityRefreshNodeRegistration): void => {
        started.push(registration);
      },
      stopForNode: (nodeId: string): void => {
        stopped.push(nodeId);
      },
      getAuthState: (nodeId: string, driverName: string): DriverAuthStateRecord | undefined => {
        authReads.push({ nodeId, driverName });
        return nodeId === NODE_ID && driverName === "codex" ? AUTH_RECORD : undefined;
      },
      shutdown: (): void => {
        shutdowns.push(shutdowns.length);
      },
    },
    started,
    stopped,
    authReads,
    shutdowns,
  };
}

/** A driver entry whose call counts the assertions read. */
interface FakeDriverEntry {
  readonly entry: CapabilityRefreshDriverEntry;
  readonly refreshCalls: number[];
  readonly probeCalls: number[];
}

function buildFakeDriverEntry(driverName: FlooredDriverName): FakeDriverEntry {
  const refreshCalls: number[] = [];
  const probeCalls: number[] = [];
  return {
    entry: {
      driverName,
      refreshDeclaration: (): Promise<DeclareDriverCapabilitiesResult> => {
        refreshCalls.push(Date.now());
        return Promise.resolve({ emitted: "noop", cliVersionRefreshed: false });
      },
      probeAuth: (): Promise<DriverAuthProbeResult> => {
        probeCalls.push(Date.now());
        return Promise.resolve({ status: "authenticated" });
      },
    },
    refreshCalls,
    probeCalls,
  };
}

// ----------------------------------------------------------------------------
// Unit cases — the observer's two verbs and the plane's two reads
// ----------------------------------------------------------------------------

describe("NodeProviderPlane — lifecycle delegation", () => {
  it("starts the node's cadence at registration with the entries resolved from the FULL context", () => {
    const recording: RecordingScheduler = makeRecordingScheduler();
    const codex: FakeDriverEntry = buildFakeDriverEntry("codex");
    const claude: FakeDriverEntry = buildFakeDriverEntry("claude");
    const resolverContexts: RuntimeNodeLifecycleContext[] = [];
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler: recording.scheduler,
      resolveDriverEntries: (context: RuntimeNodeLifecycleContext) => {
        resolverContexts.push(context);
        return [codex.entry, claude.entry];
      },
    });

    plane.onNodeRegistered({ nodeId: NODE_ID, sessionId: SESSION_ID });

    expect(recording.started).toStrictEqual([
      { nodeId: NODE_ID, drivers: [codex.entry, claude.entry] },
    ]);
    // The resolver sees the session too — a per-node entry's refresh leg
    // declares against a session-scoped target, so a node-id-only notification
    // would force a second node→session map into the bootstrap.
    expect(resolverContexts).toStrictEqual([{ nodeId: NODE_ID, sessionId: SESSION_ID }]);
    expect(recording.stopped).toHaveLength(0);
  });

  it("stops the node's cadence at detach, keyed on the node alone", () => {
    const recording: RecordingScheduler = makeRecordingScheduler();
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler: recording.scheduler,
      resolveDriverEntries: () => [],
    });

    plane.onNodeDetached({ nodeId: NODE_ID, sessionId: SESSION_ID });
    plane.onNodeDetached({ nodeId: OTHER_NODE_ID, sessionId: SESSION_ID });

    expect(recording.stopped).toStrictEqual([NODE_ID, OTHER_NODE_ID]);
    expect(recording.started).toHaveLength(0);
  });

  it("does not swallow a resolver fault — a broken bootstrap must not look like a healthy empty node", () => {
    const recording: RecordingScheduler = makeRecordingScheduler();
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler: recording.scheduler,
      resolveDriverEntries: () => {
        throw new Error("driver entries unresolvable");
      },
    });

    expect(() => {
      plane.onNodeRegistered({ nodeId: NODE_ID, sessionId: SESSION_ID });
    }).toThrow("driver entries unresolvable");
    // Containment is the REGISTRY's (it keeps the registration alive and
    // reports the throw); catching here would have started a node with an
    // empty driver set that polls nothing and reports nothing.
    expect(recording.started).toHaveLength(0);
  });

  it("delegates the admission-side auth read verbatim, including a miss", () => {
    const recording: RecordingScheduler = makeRecordingScheduler();
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler: recording.scheduler,
      resolveDriverEntries: () => [],
    });

    expect(plane.getAuthState(NODE_ID, "codex")).toStrictEqual(AUTH_RECORD);
    // A driver never polled on this node reads `undefined` — the fail-closed
    // direction for the admission gate that consumes this.
    expect(plane.getAuthState(NODE_ID, "claude")).toBeUndefined();
    expect(recording.authReads).toStrictEqual([
      { nodeId: NODE_ID, driverName: "codex" },
      { nodeId: NODE_ID, driverName: "claude" },
    ]);
  });

  it("delegates shutdown so the daemon shutdown path has one call", () => {
    const recording: RecordingScheduler = makeRecordingScheduler();
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler: recording.scheduler,
      resolveDriverEntries: () => [],
    });

    plane.shutdown();
    expect(recording.shutdowns).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// The composition helper — the one call a bootstrap makes per driver
// ----------------------------------------------------------------------------

describe("composeCapabilityRefreshDriverEntry", () => {
  // A driver double holding transport state, so a probe leg that lost its
  // receiver would throw rather than quietly answering from a free function.
  class StatefulProbeDriver {
    readonly #status: DriverAuthProbeResult["status"];
    probeCalls: number = 0;

    constructor(status: DriverAuthProbeResult["status"]) {
      this.#status = status;
    }

    probeAuth(): Promise<DriverAuthProbeResult> {
      this.probeCalls += 1;
      return Promise.resolve({ status: this.#status });
    }
  }

  it("binds the driver's own probe (receiver preserved) and passes the declaration thunk through", async () => {
    const driver: StatefulProbeDriver = new StatefulProbeDriver("unauthenticated");
    const declarationCalls: number[] = [];
    const entry: CapabilityRefreshDriverEntry = composeCapabilityRefreshDriverEntry({
      driverName: "codex",
      driver,
      refreshDeclaration: (): Promise<DeclareDriverCapabilitiesResult> => {
        declarationCalls.push(declarationCalls.length);
        return Promise.resolve({ emitted: "updated", cliVersionRefreshed: true });
      },
    });

    expect(entry.driverName).toBe("codex");
    // Reading `#status` through a lost `this` would throw, so a passing status
    // assertion is the receiver assertion.
    await expect(entry.probeAuth()).resolves.toStrictEqual({ status: "unauthenticated" });
    expect(driver.probeCalls).toBe(1);
    await expect(entry.refreshDeclaration()).resolves.toStrictEqual({
      emitted: "updated",
      cliVersionRefreshed: true,
    });
    expect(declarationCalls).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Integration — the real registry lifecycle drives the real cadence
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-node-provider-plane-test-"));
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  ctx = { db, tmpDir };
});

afterEach(() => {
  // The refresh timers are node-scoped module state only through the scheduler
  // instance, but the fake clock is global — restore it before the next case.
  vi.useRealTimers();
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

/** Fixed-key signing source — this suite is about the wiring, not custody. */
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

// The production composition over one `db` handle, with the plane injected as
// the registry's lifecycle observer — which is the wiring under test.
function makeObservedRegistry(plane: NodeProviderPlane): NodeRegistry {
  let idCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    sessionEvents: new EventLogService({
      db: ctx.db,
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
    newEventId: () => `evt-plane-${(idCounter++).toString()}`,
  });
  return new NodeRegistry(ctx.db, emitter, () => "2026-06-02T12:00:00.000Z", {
    lifecycleObserver: plane,
  });
}

describe("NodeProviderPlane — registry-driven refresh cadence", () => {
  it("polls on the cadence after a real register, and stops polling after a real detach", async () => {
    const codex: FakeDriverEntry = buildFakeDriverEntry("codex");
    const scheduler: CapabilityRefreshScheduler = new CapabilityRefreshScheduler({
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: () => undefined },
        counterSink: { increment: () => undefined },
      }),
    });
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler,
      resolveDriverEntries: () => [codex.entry],
    });
    const registry: NodeRegistry = makeObservedRegistry(plane);

    // The clock must be fake BEFORE the register: the node's interval is armed
    // synchronously inside the observer notification, and an interval armed on
    // the real clock is not one `advanceTimersByTime` can drive. A pinned
    // system time keeps the emitted envelopes' timestamps sane; nothing in the
    // append path is timer-driven, so awaiting it under the fake clock resolves
    // on microtasks as usual.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));

    await registry.register({
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      capabilities: {},
      nodeVersion: "1.0.0",
      platform: "linux-x64",
    });

    // Nothing polls before the first full cadence — attach itself declares.
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS - 1);
    expect(codex.refreshCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(codex.refreshCalls).toHaveLength(1);
    // The PAIR ran, and the reading is readable through the plane's
    // admission-side accessor — which is the whole point of starting the poll.
    expect(codex.probeCalls).toHaveLength(1);
    expect(plane.getAuthState(NODE_ID, "codex")?.status).toBe("authenticated");

    await registry.detach({ nodeId: NODE_ID, sessionId: SESSION_ID, previousState: "online" });

    // The timer is gone and the node's auth records went with it: a retained
    // `authenticated` reading would let a later admission rest on credentials
    // probed under a registration that no longer exists.
    expect(plane.getAuthState(NODE_ID, "codex")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS * 3);
    expect(codex.refreshCalls).toHaveLength(1);
    expect(codex.probeCalls).toHaveLength(1);
  });

  it("does not arm a cadence for a registration that failed", async () => {
    // The registry contains and reports a throwing observer, so this case
    // asserts the complementary half from the provider side: a register that
    // never settles leaves no timer behind to poll a node that was never
    // recorded.
    const codex: FakeDriverEntry = buildFakeDriverEntry("codex");
    const scheduler: CapabilityRefreshScheduler = new CapabilityRefreshScheduler({
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: () => undefined },
        counterSink: { increment: () => undefined },
      }),
    });
    const plane: NodeProviderPlane = new NodeProviderPlane({
      scheduler,
      resolveDriverEntries: () => [codex.entry],
    });
    // A signing source that refuses makes the append fail before its
    // transaction opens — the registration never happens.
    class RefusingSigningKeySource implements DaemonSigningKeySource {
      read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
        return Promise.reject(new Error("key unseal refused"));
      }
      create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
        return Promise.reject(new Error("unused"));
      }
    }
    const registry: NodeRegistry = new NodeRegistry(
      ctx.db,
      new RuntimeNodeEventEmitter({
        sessionEvents: new EventLogService({
          db: ctx.db,
          signingKeySource: new RefusingSigningKeySource(),
        }),
      }),
      () => "2026-06-02T12:00:00.000Z",
      { lifecycleObserver: plane },
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));

    await expect(
      registry.register({
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        capabilities: {},
        nodeVersion: "1.0.0",
        platform: "linux-x64",
      }),
    ).rejects.toThrow("key unseal refused");

    await vi.advanceTimersByTimeAsync(CAPABILITY_REFRESH_INTERVAL_MS * 3);
    expect(codex.refreshCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

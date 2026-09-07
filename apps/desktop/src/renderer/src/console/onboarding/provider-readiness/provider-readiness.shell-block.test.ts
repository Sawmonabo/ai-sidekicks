// The re-check is a MUTATION, and a supervisor that is not serving closes it.
//
// THE DEFECT THIS CLOSES. `providerAccount.probe` is a mutating daemon verb and the
// only condition the row's control had was whether another act on that same row was
// running — so while the shell was starting, reconnecting, offline, stopped, or
// version-incompatible, a person could press **Check again** and this window would put
// a write through a supervisor that had already been reported as unable to take one.
//
// WHAT IS ASSERTED IS THE CALL, off `withDaemonCall`'s record, because every
// state-shaped assertion here would pass on a model that dispatched the probe and threw
// the reply away. The read beside it is the negative control in every blocked case: it
// leaves under the identical condition, because the store's seam answers per METHOD —
// a case where nothing at all left the window would prove a broken bridge rather than a
// working guard.
//
// AND THE LIVE HALF IS ITS OWN CASE. A block sampled at construction would leave the
// control dead for the life of the window; a block republished on every store publish
// would re-render every row on every heartbeat. Both are cases below, and they are the
// two ways the subscription can be wrong in opposite directions.
//
// SPLIT FROM `provider-readiness.test.ts` next door, which drives the same model over
// the same fixture and asserts what the projection and the acts answer. This file
// asserts what the WINDOW costs them, and together they were one file past the
// package's ceiling.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import {
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { FrameStore, type ShellConnection } from "../../store/index.js";
import type { ProviderReadinessModel } from "./provider-readiness.js";
import {
  READINESS_CALL,
  arrive,
  fixture,
  modelOver,
  reportShellConnection,
} from "./provider-readiness.test-support.js";

/** The probe the re-check dispatches. Counted, so "no call left" is measurable. */
const PROBE_CALL = "providerAccount.probe";

/**
 * Every supervisor condition that closes a mutating call.
 *
 * Written out rather than derived from the store's own derivation, so each case is a
 * claim about which conditions block rather than a restatement of the function under
 * test. The two conditions that block nothing are the last case in this file, which is
 * what keeps the enumeration from being trivially satisfiable by a model that refused
 * always.
 */
const BLOCKING_CONNECTIONS: readonly ShellConnection[] = [
  { kind: "probing" },
  { kind: "starting" },
  { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
  { kind: "version-incompatible" },
  { kind: "offline", attemptLimit: 5, lastError: undefined },
  { kind: "stopped" },
];

/** The condition a person is actually looking at when the retry banner is up. */
const OFFLINE: ShellConnection = { kind: "offline", attemptLimit: 5, lastError: undefined };

/** A model over the shipped fixture whose own window store this case drives. */
function caseWith(connection: ShellConnection): {
  readonly model: ProviderReadinessModel;
  readonly frameStore: FrameStore;
  readonly calls: readonly RecordedDaemonCall[];
} {
  const held = withDaemonCall(fixture(), async (_call, passThrough) => passThrough());
  const frameStore = new FrameStore();
  reportShellConnection(frameStore, connection);
  return { model: modelOver(held.bridge, frameStore), frameStore, calls: held.calls };
}

/** How many probes actually left this window. */
function probeCount(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((call) => call.method === PROBE_CALL).length;
}

/** How many readiness reads actually left it. The per-method negative control. */
function readCount(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((call) => call.method === READINESS_CALL).length;
}

/** Arrive, and answer the account the scenario resolves for its signed-out provider. */
async function arriveAtResolvedAccount(model: ProviderReadinessModel): Promise<ProviderAccountId> {
  await arrive(model);
  const { reading } = model;
  if (reading.kind !== "read") {
    throw new Error("the fixture did not serve a readiness projection");
  }
  const accountId = reading.entries[1]?.resolvedAccountId;
  if (accountId === undefined) {
    throw new Error("the fixture did not resolve an account for the signed-out provider");
  }
  return accountId;
}

describe("the re-check while the shell cannot be written to", () => {
  it.each(BLOCKING_CONNECTIONS)(
    "puts no probe while the supervisor reports $kind, and names its cause",
    async (connection) => {
      const { model, calls } = caseWith(connection);
      const accountId = await arriveAtResolvedAccount(model);
      // The per-method negative control: the read behind every figure on this step went
      // out under the identical condition, because a read is not a mutation.
      expect(readCount(calls)).toBe(1);

      await model.recheck("codex", accountId);

      expect(probeCount(calls)).toBe(0);
      // Neither a spinner nothing settles nor a silent no-op: the cause rides the
      // snapshot the row renders, which is where its control reads its own reason.
      expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
      expect(model.snapshot.recheckBlock?.detail ?? "").not.toBe("");
    },
  );

  it("dispatches once the supervisor is serving again, without a remount", async () => {
    const { model, frameStore, calls } = caseWith(OFFLINE);
    const accountId = await arriveAtResolvedAccount(model);
    await model.recheck("codex", accountId);
    expect(probeCount(calls)).toBe(0);

    // The live half. A block sampled at construction leaves this control dead for the
    // life of the window, and a person who watched the runtime come back is looking at
    // a control that still refuses.
    reportShellConnection(frameStore, { kind: "connected" });

    expect(model.snapshot.recheckBlock).toBeUndefined();
    await model.recheck("codex", accountId);
    expect(probeCount(calls)).toBe(1);
  });

  it("publishes nothing when a report moves and the block does not", async () => {
    const frameStore = new FrameStore();
    const model = modelOver(fixture(), frameStore);
    await arrive(model);
    const beforeHeartbeat = model.snapshot;

    // A heartbeat replaces the shell state and leaves the block exactly where it was.
    // Republishing on that re-renders every provider row several times a minute.
    frameStore.publishShellReport({
      connection: { kind: "connected" },
      negotiation: undefined,
      lastHeartbeatAt: "2026-01-01T09:00:00.000Z",
      transport: undefined,
      keystore: undefined,
    });

    expect(model.snapshot).toBe(beforeHeartbeat);
  });

  it("stops deriving from the store once the step is retired", async () => {
    const frameStore = new FrameStore();
    const model = modelOver(fixture(), frameStore);
    await arrive(model);
    const beforeSupersede = model.snapshot;

    model.supersede();
    reportShellConnection(frameStore, { kind: "stopped" });

    expect(model.snapshot).toBe(beforeSupersede);
  });

  it("blocks nothing while the supervisor is serving or has not reported", () => {
    for (const connection of [{ kind: "unreported" }, { kind: "connected" }] as const) {
      const frameStore = new FrameStore();
      reportShellConnection(frameStore, connection);
      expect(
        modelOver(fixture(), frameStore).snapshot.recheckBlock,
        connection.kind,
      ).toBeUndefined();
    }
  });
});

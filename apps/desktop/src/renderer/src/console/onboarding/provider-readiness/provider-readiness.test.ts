// The provider step reads the daemon's projection and composes none of its own.
//
// THREE CLAIMS. The readiness entries are carried VERBATIM from the reply — the
// member is required precisely so no client re-derives it. A re-check probes ONE
// account and then re-reads, because the probe answers about an account and the
// derivation answers about a provider, and reading the probe's own reply as the row's
// new state would be exactly that re-derivation. And a hand-off's SETTLEMENT is never
// read as success: what the row reports afterwards is the projection re-read, because
// the probe defines success and the sign-in process's exit does not.
//
// AND A FOURTH, WHICH IS WHAT THE TRIGGER CONTRACT COSTS. Every case here reaches the
// wire through `requestRead`, because that is the only entry this model has — the
// suite that drove a public `read()` proved the daemon answered and proved nothing at
// all about the path the console actually takes. What is asserted is the CALL, off
// `withDaemonCall`'s record: a `requestRead` that published nothing would satisfy
// every reading-shaped assertion in this file and leave the step exactly as stale as
// it was before the scheduler existed.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../../bridge/index.js";
import {
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import { ONBOARDING_SCENARIO } from "../../bridge/scenarios/onboarding.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  accountsForProvider,
  providersNotReady,
  type ProviderReadinessModel,
} from "./provider-readiness.js";
import { READINESS_CALL, arrive, fixture, modelOver } from "./provider-readiness.test-support.js";

/**
 * A model over a bridge that records what it was asked, answering from the scenario.
 *
 * The record is what every coalescing and disposal case below asserts on, and the
 * pass-through is why they can: each case still reads the scenario's own projection,
 * so an assertion about the number of calls sits beside one about what they answered
 * rather than replacing it.
 */
function recordingModel(bridge: ConsoleBridge = fixture()): {
  readonly model: ProviderReadinessModel;
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedDaemonCall[];
} {
  const held = withDaemonCall(bridge, async (_call, passThrough) => passThrough());
  return { model: modelOver(held.bridge), bridge: held.bridge, calls: held.calls };
}

/** How many readiness reads actually left this window. */
function readCount(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((call) => call.method === READINESS_CALL).length;
}

/**
 * The same scenario with the readiness read scripted to REFUSE.
 *
 * A scenario reply and never a hand-built bridge whose `daemon` namespace has been
 * spread over: the account plane refuses in the wire's own `{code, message}` shape,
 * and a stub rejecting with an `Error` would train this model against a value the
 * live transport never sends. It is also the shape the daemon-reply chokepoint gate
 * requires — a test that took the namespace would be a second reading of the door.
 */
function refusingFixture(): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      ...ONBOARDING_SCENARIO,
      replies: [
        ...ONBOARDING_SCENARIO.replies.filter((reply) => reply.call !== READINESS_CALL),
        {
          call: READINESS_CALL,
          refusal: {
            code: "provideraccount.unknown",
            message: "This node could not read its provider-account registry.",
          },
        },
      ],
    },
  });
}

describe("reading which providers this node can run", () => {
  it("carries the daemon's own readiness entries, remedy included", async () => {
    const model = modelOver(fixture());
    await arrive(model);
    const { reading } = model;
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") {
      return;
    }
    expect(reading.entries.map((entry) => entry.state)).toStrictEqual([
      "authenticated",
      "reauth_required",
    ]);
    const codex = reading.entries[1];
    expect(codex?.remedy?.kind).toBe("sign_in");
    // The authenticated arm is the one that gets no remedy, because nothing is owed.
    expect(reading.entries[0]?.remedy).toBeUndefined();
  });

  it("renders the daemon's refusal rather than an empty provider list", async () => {
    const model = modelOver(refusingFixture());
    await arrive(model);
    expect(model.reading.kind).toBe("unreadable");
  });
});

describe("the acts the step performs", () => {
  it("probes one account and then re-reads, rather than reading the probe as the state", async () => {
    const model = modelOver(fixture());
    await arrive(model);
    const reading = model.reading;
    if (reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const codex = reading.entries[1];
    const accountId = codex?.resolvedAccountId;
    if (accountId === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }
    await model.recheck("codex", accountId);
    // The scenario's probe answers `reauth_required` and its projection says the same,
    // so the row is unchanged — which is the point: the projection is what moved it.
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
    expect(model.reading.kind).toBe("read");
  });

  it("reports a hand-off as started and never as signed in", async () => {
    const model = modelOver(fixture());
    await model.handOffSignIn("codex");
    expect(model.actionFor("codex")).toStrictEqual({ kind: "handed-off" });
    // And the projection was re-read, which is the only thing that could report a
    // provider as ready.
    expect(model.reading.kind).toBe("read");
  });

  it("renders a refused hand-off on the row that asked", async () => {
    const base = fixture();
    const refusing: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingProviderSignInHandoff: async () =>
          growthUnavailable("onboardingProviderSignInHandoff"),
      },
    };
    const model = modelOver(refusing);
    await model.handOffSignIn("codex");
    const action = model.actionFor("codex");
    expect(action.kind).toBe("refused");
    if (action.kind !== "refused") {
      return;
    }
    expect(action.refusal.code).toBe("wire-unregistered");
  });

  it("publishes nothing after the step was retired", async () => {
    const model = modelOver(fixture());
    model.requestRead("subscribe");
    model.supersede();
    await crossMacrotaskBoundary();
    expect(model.reading).toStrictEqual({ kind: "reading" });
  });
});

describe("the trigger contract — what an arrival, a focus, and a retirement cost", () => {
  it("puts the arrival read on the wire, which nothing else in this file proves", async () => {
    const { model, calls } = recordingModel();
    // The negative control, and it is the state a no-op `requestRead` would leave: no
    // call has left this window and the reading is the zero-state. Every assertion
    // below is measured against it, so a `requestRead` that published nothing fails
    // here rather than passing on a reading some earlier line had already settled.
    expect(readCount(calls)).toBe(0);
    expect(model.reading).toStrictEqual({ kind: "reading" });

    await arrive(model);

    expect(readCount(calls)).toBe(1);
    expect(model.reading.kind).toBe("read");
  });

  it("re-reads at the scope it was addressed at, and never widens to the default", async () => {
    const { model, calls } = recordingModel();
    await arrive(model);
    const reading = model.reading;
    if (reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const scope = reading.entries[1]?.resolvedAccountId;
    if (scope === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }
    // Addressing performs no read of its own: the count is unmoved until a reason asks.
    model.addressAt(scope);
    expect(readCount(calls)).toBe(1);

    await arrive(model);

    const readCalls = calls.filter((call) => call.method === READINESS_CALL);
    expect(readCalls).toHaveLength(2);
    // The unscoped arrival first, then the addressed one. A scope the model forgot
    // would repeat the empty request and answer about the provider default.
    expect(readCalls.map((call) => call.params)).toStrictEqual([{}, { accountId: scope }]);
  });

  it("coalesces a burst of focus reasons into one read", async () => {
    const { model, bridge, calls } = recordingModel();
    await arrive(model);
    expect(readCount(calls)).toBe(1);

    // Two reasons inside one window — the window regaining focus twice, which is what
    // an operator alt-tabbing back and forth actually raises.
    model.requestRead("window-focus");
    model.requestRead("window-focus");
    await settleScheduledRead(bridge);

    expect(readCount(calls)).toBe(2);
  });

  it("disposes the scheduler on supersede, so a later trigger performs nothing", async () => {
    const { model, bridge, calls } = recordingModel();
    await arrive(model);
    expect(readCount(calls)).toBe(1);

    model.supersede();
    model.requestRead("window-focus");
    await settleScheduledRead(bridge);

    // A retired step whose scheduler still fired would put a read on the wire for a
    // surface nobody is looking at, and settle it into a model nothing renders.
    expect(readCount(calls)).toBe(1);
  });
});

describe("what the completion summary is told", () => {
  it("names every provider that is not ready, and only those", async () => {
    const model = modelOver(fixture());
    await arrive(model);
    const { reading } = model;
    if (reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    expect(providersNotReady(reading.entries)).toStrictEqual(["codex"]);
    expect(
      accountsForProvider(reading.accounts, "codex").map((one) => one.displayLabel),
    ).toStrictEqual(["Personal"]);
  });
});

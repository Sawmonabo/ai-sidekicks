// The provider step reads the daemon's projection and composes none of its own.
//
// TWO CLAIMS. The readiness entries are carried VERBATIM from the reply — the member
// is required precisely so no client re-derives it. And a re-check probes ONE account
// and then re-reads, because the probe answers about an account and the derivation
// answers about a provider, and reading the probe's own reply as the row's new state
// would be exactly that re-derivation.
//
// WHAT THIS MODEL NEVER DISPATCHES is asserted next door in
// `provider-readiness.no-sign-in.test.ts`, which also carries the probe's own refusal
// arm — the two halves of a deleted sign-in act, split off when the pair took this
// file past the package's ceiling.
//
// AND A THIRD, ABOUT WHAT A SUBSCRIBER CAN SEE. This model publishes two facts that
// move independently, and the only one a surface could compare used to be the
// projection — so a per-provider act published, `useSyncExternalStore` compared a
// reading that had not re-identified, and React rendered nothing. The snapshot suite
// asserts on IDENTITY for that reason: an act that changes state and leaves the
// comparable value alone is a change nothing downstream can act on.
//
// AND A FOURTH, WHICH IS WHAT THE TRIGGER CONTRACT COSTS. Every case here reaches the
// wire through `requestRead`, because that is the only entry this model has — the
// suite that drove a public `read()` proved the daemon answered and proved nothing at
// all about the path the console actually takes. What is asserted is the CALL, off
// `withDaemonCall`'s record: a `requestRead` that published nothing would satisfy
// every reading-shaped assertion in this file and leave the step exactly as stale as
// it was before the scheduler existed.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import { ONBOARDING_SCENARIO } from "../../bridge/scenarios/onboarding.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { accountsForProvider, providersNotReady } from "./provider-readiness-reading.js";
import {
  PROBE_CALL,
  READINESS_CALL,
  arrive,
  fixture,
  modelOver,
  providerAccountRecord,
  readCount,
  recordingModel,
} from "./provider-readiness.test-support.js";

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

/**
 * The account id the stale reply below resolves, named once so both halves agree.
 *
 * A plain string, on the test-support module's rule: it is only ever written INTO a
 * scripted reply, which is untyped by design, and read back off the projection the
 * daemon door parsed.
 */
const STALE_ACCOUNT_ID = "acct-codex-superseded";

/**
 * A registry projection distinguishable from the fixture's, for an OLDER read.
 *
 * One readiness entry against the fixture's two, so the two replies cannot be
 * confused for one another by a case that only counts calls: whichever of them
 * published last is legible from the states alone. A whole reply and not a patch of
 * the shipped one, on `refusingFixture`'s shape — it is schema-parsed on the way back
 * through the daemon door, so it is held to the registered contract exactly as the
 * fixture's own is.
 */
function staleReadinessReply(): unknown {
  return {
    accounts: [
      providerAccountRecord({
        accountId: STALE_ACCOUNT_ID,
        displayLabel: "Personal",
        isDefault: true,
      }),
    ],
    usageWindows: [],
    readiness: [
      {
        provider: "codex",
        state: "authenticated",
        resolvedAccountId: STALE_ACCOUNT_ID,
        observedAt: "2026-01-01T08:00:00.000Z",
      },
    ],
  };
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

  it("drops an older read whose reply lands after a newer one", async () => {
    // THE DEFECT THIS PINS. The generation this model stamps a call with moves only
    // when the account SCOPE moves, so an arrival read and a focus-triggered refresh
    // of the same scope carried the same stamp — and the older of the two passed the
    // check on the way back, installing a projection the daemon had already replaced.
    let readinessReads = 0;
    let releaseOlderRead: (() => void) | undefined;
    const held = withDaemonCall(fixture(), async (call, passThrough) => {
      if (call.method !== READINESS_CALL) {
        return passThrough();
      }
      readinessReads += 1;
      if (readinessReads > 1) {
        return passThrough();
      }
      // The arrival read, held open until the refresh behind it has already landed.
      await new Promise<void>((resolve) => {
        releaseOlderRead = resolve;
      });
      return staleReadinessReply();
    });
    const model = modelOver(held.bridge);

    model.requestRead("subscribe");
    await crossMacrotaskBoundary();
    model.requestRead("window-focus");
    await settleScheduledRead(held.bridge);

    const afterNewerRead = model.reading;
    if (afterNewerRead.kind !== "read") {
      throw new Error("the refresh did not settle a readiness projection");
    }
    expect(afterNewerRead.entries.map((entry) => entry.state)).toStrictEqual([
      "authenticated",
      "reauth_required",
    ]);

    releaseOlderRead?.();
    await crossMacrotaskBoundary();

    // Identity and not only shape: an older reply that published would replace the
    // snapshot's reading object even where the states it carried happened to match.
    expect(model.reading).toBe(afterNewerRead);
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

describe("what a subscribed surface compares", () => {
  it("re-identifies the snapshot when a per-provider act moves and the projection does not", async () => {
    // A probe that never settles, so the only thing that has happened is the
    // `rechecking` publish — no re-read has replaced the reading object behind it.
    const neverSettles = new Promise<never>(() => undefined);
    const held = withDaemonCall(fixture(), async (call, passThrough) =>
      call.method === PROBE_CALL ? neverSettles : passThrough(),
    );
    const model = modelOver(held.bridge);
    await arrive(model);
    const beforeProbe = model.snapshot;
    if (beforeProbe.reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const accountId = beforeProbe.reading.entries[1]?.resolvedAccountId;
    if (accountId === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }

    void model.recheck("codex", accountId);
    await crossMacrotaskBoundary();

    expect(model.actionFor("codex")).toStrictEqual({ kind: "rechecking" });
    // The projection is untouched — which is exactly why the reading alone could not
    // carry this — and the snapshot has moved anyway.
    expect(model.snapshot.reading).toBe(beforeProbe.reading);
    expect(model.snapshot).not.toBe(beforeProbe);
  });

  it("re-identifies the snapshot when the projection moves", async () => {
    const { model, bridge, calls } = recordingModel();
    await arrive(model);
    const afterArrival = model.snapshot;
    expect(readCount(calls)).toBe(1);

    model.requestRead("window-focus");
    await settleScheduledRead(bridge);

    expect(readCount(calls)).toBe(2);
    expect(model.snapshot).not.toBe(afterArrival);
  });

  it("holds no act map any second model could reach", async () => {
    // `ReadonlyMap` is the compile-time view. A zero state held at module scope would
    // be one stray `set` away from reporting a hand-off on a window that never made
    // one, so the two models are handed two objects.
    expect(modelOver(fixture()).snapshot.actions).not.toBe(modelOver(fixture()).snapshot.actions);
  });
});

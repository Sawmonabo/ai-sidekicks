// The provider step reads the daemon's projection and composes none of its own.
//
// THREE CLAIMS. The readiness entries are carried VERBATIM from the reply — the
// member is required precisely so no client re-derives it. A re-check probes ONE
// account and then re-reads, because the probe answers about an account and the
// derivation answers about a provider, and reading the probe's own reply as the row's
// new state would be exactly that re-derivation. And a hand-off's SETTLEMENT is never
// read as success: what the row reports afterwards is the projection re-read, because
// the probe defines success and the sign-in process's exit does not.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import {
  ProviderReadinessModel,
  accountsForProvider,
  providersNotReady,
} from "./provider-readiness.js";

function modelOver(bridge: ConsoleBridge): ProviderReadinessModel {
  return new ProviderReadinessModel(bridge);
}

function fixture(): ConsoleBridge {
  return createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
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
        ...ONBOARDING_SCENARIO.replies.filter((reply) => reply.call !== "providerAccount.list"),
        {
          call: "providerAccount.list",
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
    await model.read(undefined);
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
    await model.read(undefined);
    expect(model.reading.kind).toBe("unreadable");
  });
});

describe("the acts the step performs", () => {
  it("probes one account and then re-reads, rather than reading the probe as the state", async () => {
    const model = modelOver(fixture());
    await model.read(undefined);
    const reading = model.reading;
    if (reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const codex = reading.entries[1];
    const accountId = codex?.resolvedAccountId;
    if (accountId === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }
    await model.recheck("codex", accountId, undefined);
    // The scenario's probe answers `reauth_required` and its projection says the same,
    // so the row is unchanged — which is the point: the projection is what moved it.
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
    expect(model.reading.kind).toBe("read");
  });

  it("reports a hand-off as started and never as signed in", async () => {
    const model = modelOver(fixture());
    await model.handOffSignIn("codex", undefined);
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
    await model.handOffSignIn("codex", undefined);
    const action = model.actionFor("codex");
    expect(action.kind).toBe("refused");
    if (action.kind !== "refused") {
      return;
    }
    expect(action.refusal.code).toBe("wire-unregistered");
  });

  it("publishes nothing after the step was retired", async () => {
    const model = modelOver(fixture());
    const pending = model.read(undefined);
    model.supersede();
    await pending;
    expect(model.reading).toStrictEqual({ kind: "reading" });
  });
});

describe("what the completion summary is told", () => {
  it("names every provider that is not ready, and only those", async () => {
    const model = modelOver(fixture());
    await model.read(undefined);
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

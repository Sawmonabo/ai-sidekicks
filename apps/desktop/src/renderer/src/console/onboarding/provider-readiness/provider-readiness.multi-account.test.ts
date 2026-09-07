// One provider, two credential homes: what the step has to carry and what it drops.
//
// SPLIT FROM `provider-readiness.test.ts`, and split on the premise rather than on
// size. Every case here needs a provider whose registry holds more than one account,
// and with a single account both defects below are invisible: the account a hand-off
// would elect for itself and the account whose remedy is on screen are the same id,
// and a scope that never changes retires nothing that could have gone stale. The
// scenario that makes them two different values lives in the support module beside
// this file, because the suite next door drives the same model over the same fixture.
//
// TWO CLAIMS, AND EACH IS A THING A SURFACE BEHIND THE BRIDGE MUST NOT BE LEFT TO
// GUESS. The hand-off names the account whose remedy was rendered, so a multi-account
// provider is authenticated where the person was looking rather than wherever the
// default points. And a change of the addressed account retires what the previous one
// produced — its reading and its per-provider actions both — so a reply still
// travelling for the previous account installs nothing over the new one, and the
// previous one's outcome is neither displayed nor pressable.

import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthServing,
  withDaemonCall,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  READINESS_CALL,
  arrive,
  modelOver,
  twoAccountScenario,
} from "./provider-readiness.test-support.js";

describe("handing off to a provider with more than one account", () => {
  it("hands off the account whose remedy was rendered, not the provider default", async () => {
    const handOff = vi.fn(growthServing(undefined));
    const model = modelOver(
      fixtureBridgeWithGrowth(twoAccountScenario(), {
        onboardingProviderSignInHandoff: handOff,
      }),
    );
    await arrive(model);
    const reading = model.reading;
    if (reading.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const remedy = reading.entries[0]?.remedy;
    if (remedy?.kind !== "sign_in") {
      throw new Error("the fixture did not compose a sign-in remedy for the two-account provider");
    }
    // The premise, asserted rather than assumed: the account the remedy names is NOT
    // the one this provider defaults to, so the two candidate values differ and the
    // assertion below can tell them apart.
    expect(reading.accounts.find((account) => account.isDefault)?.accountId).not.toBe(
      remedy.accountId,
    );

    await model.handOffSignIn("codex");

    // The whole request, so the default account is excluded by construction rather
    // than by a second assertion that could be dropped: a hand-off naming only the
    // provider lets the surface behind it authenticate whichever home it prefers,
    // and the one it prefers is the default.
    expect(handOff).toHaveBeenCalledWith({
      providerName: "codex",
      providerAccountId: remedy.accountId,
    });
    expect(model.actionFor("codex")).toStrictEqual({ kind: "handed-off" });
  });
});

describe("re-addressing this step at a different account", () => {
  it("retires the previous scope's reading and actions when the account changes", async () => {
    const parkedReads: (() => void)[] = [];
    let readsSeen = 0;
    const { bridge } = withDaemonCall(
      createFixtureBridge({ scenario: twoAccountScenario() }),
      async (call, passThrough) => {
        if (call.method !== READINESS_CALL) {
          return await passThrough();
        }
        readsSeen += 1;
        if (readsSeen === 1) {
          return await passThrough();
        }
        // Parked rather than delayed on the scenario clock: what this case is about
        // is the window between a read leaving and its reply landing, and that window
        // only exists while the case owns when the reply lands.
        return await new Promise<unknown>((resolveRead) => {
          parkedReads.push(() => {
            resolveRead(passThrough());
          });
        });
      },
    );
    const model = modelOver(bridge);

    // The step opens at the provider default, which is the scope this model starts
    // addressed at, and that read settles.
    await arrive(model);
    const settledUnderDefault = model.reading;
    if (settledUnderDefault.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const secondScope = settledUnderDefault.entries[0]?.resolvedAccountId;
    if (secondScope === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }

    // An act settles under that scope, and the re-read it starts is left in flight —
    // which is the window this defect lived in.
    const handOffUnderDefaultScope = model.handOffSignIn("codex");
    await crossMacrotaskBoundary();
    expect(model.actionFor("codex")).toStrictEqual({ kind: "handed-off" });
    expect(parkedReads).toHaveLength(1);

    model.addressAt(secondScope);

    // What the previous scope produced is neither on screen nor pressable against an
    // account that never produced it.
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
    expect(model.reading).toStrictEqual({ kind: "reading" });

    parkedReads[0]?.();
    await handOffUnderDefaultScope;
    await crossMacrotaskBoundary();

    // And the previous scope's reply installs nothing over the account now addressed:
    // a generation that had not advanced with the scope would publish it here.
    expect(model.reading).toStrictEqual({ kind: "reading" });
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
  });
});

// One provider, two credential homes: what the step has to carry and what it drops.
//
// SPLIT FROM `provider-readiness.test.ts`, and split on the premise rather than on
// size. Every case here needs a provider whose registry holds more than one account,
// and with a single account both defects below are invisible: the remedy on screen and
// the provider's default name the same credential home, and a scope that never changes
// retires nothing that could have gone stale. The scenario that makes them two
// different values lives in the support module beside this file, because the suite next
// door drives the same model over the same fixture.
//
// TWO CLAIMS, AND EACH IS A THING A SURFACE BEHIND THE BRIDGE MUST NOT BE LEFT TO
// GUESS. The remedy this step renders is the one the daemon composed for the account
// readiness RESOLVED — its own invocation and its own credential home, and not the
// default account's — and nothing is dispatched against it, which is the whole of what
// `Spec-026 §Provider Authentication (Group B)` asks of a sign-in step: display the
// invocation, never run it. And a change of the addressed account retires what the
// previous one produced — its per-provider act and its reading both — so a settlement
// still travelling for the previous account installs nothing over the new one, and the
// previous one's outcome is neither displayed nor pressable.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { withRecordedGrowth } from "../../bridge/fixture/fixture-bridge.growth.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import {
  PROBE_CALL,
  READINESS_CALL,
  arrive,
  modelOver,
  twoAccountScenario,
} from "./provider-readiness.test-support.js";

describe("a provider with more than one account", () => {
  it("carries the resolved account's remedy, and asks no port to perform it", async () => {
    const recorded = withRecordedGrowth(createFixtureBridge({ scenario: twoAccountScenario() }));
    const model = modelOver(recorded.bridge);
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
    // the one this provider defaults to, so the two candidate homes differ and the
    // assertion below can tell them apart. A step that elected an account for itself
    // would name the default's home here.
    expect(reading.accounts.find((account) => account.isDefault)?.accountId).not.toBe(
      remedy.accountId,
    );
    expect(remedy.credentialHomePath).toBe(
      "/Users/you/Library/Application Support/sidekicks/codex/work",
    );
    expect(remedy.signInInvocation).toBe("codex login");

    // AND NOTHING WAS DISPATCHED FOR IT. The step used to hand this remedy to a growth
    // operation that asked the daemon to start the provider's login — a sixth
    // `onboarding.*` mutation the corpus does not have, on a flow `Spec-029 §Brokered
    // interactive sign-in` keeps out of the login path on purpose. What proves the
    // absence is the port's own record.
    expect(recorded.operationIds).toStrictEqual([]);
  });
});

describe("re-addressing this step at a different account", () => {
  it("retires an act still in flight when the account changes", async () => {
    // The probe is held open, so the act is visibly out — `rechecking` is on the row —
    // at the moment the scope moves. That is the window this defect lived in.
    const neverSettles = new Promise<never>(() => undefined);
    const { bridge } = withDaemonCall(
      createFixtureBridge({ scenario: twoAccountScenario() }),
      async (call, passThrough) => (call.method === PROBE_CALL ? neverSettles : passThrough()),
    );
    const model = modelOver(bridge);
    await arrive(model);
    const settledUnderDefault = model.reading;
    if (settledUnderDefault.kind !== "read") {
      throw new Error("the fixture did not serve a readiness projection");
    }
    const secondScope = settledUnderDefault.entries[0]?.resolvedAccountId;
    if (secondScope === undefined) {
      throw new Error("the fixture did not resolve an account for the signed-out provider");
    }

    void model.recheck("codex", secondScope);
    await crossMacrotaskBoundary();
    expect(model.actionFor("codex")).toStrictEqual({ kind: "rechecking" });

    model.addressAt(secondScope);

    // What the previous scope produced is neither on screen nor pressable against an
    // account that never produced it, and the settlement that is still travelling for
    // it publishes nothing when it lands.
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
    expect(model.reading).toStrictEqual({ kind: "reading" });
    await crossMacrotaskBoundary();
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
  });

  it("drops a re-read still travelling for the previous account", async () => {
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
    // which is the other window this defect lived in.
    const recheckUnderDefaultScope = model.recheck("codex", secondScope);
    await crossMacrotaskBoundary();
    expect(parkedReads).toHaveLength(1);

    model.addressAt(secondScope);

    expect(model.reading).toStrictEqual({ kind: "reading" });

    parkedReads[0]?.();
    await recheckUnderDefaultScope;
    await crossMacrotaskBoundary();

    // And the previous scope's reply installs nothing over the account now addressed:
    // a read line that had not ended with the scope would publish it here.
    expect(model.reading).toStrictEqual({ kind: "reading" });
    expect(model.actionFor("codex")).toStrictEqual({ kind: "idle" });
  });
});

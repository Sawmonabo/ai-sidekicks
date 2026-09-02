// What this scenario has to keep being, for the agent card and the axis switch.
//
// The card's whole difficulty is that a PENDING switch and an APPLIED one are two
// different lines reached through two different doors. This suite pins both doors
// open: a roster row still carrying an unapplied intent, and a mutation reply still
// settling with its losses declared. Either could go silently false under an edit
// that still parsed, and the card would then be built against a case with no
// counter-example in the fixture.
//
// AND IT PINS THE SHAPES, not only the states. A scripted result is stored as
// `unknown`, so a member written in the wrong shape reaches the card unchallenged
// and renders as an undefined value — a fixture that exercises a reply no daemon
// may send. The cases below parse the two members that carry a registered shape
// through the contract's OWN schema and vocabulary rather than through a local
// re-statement of either.

import { describe, expect, it } from "vitest";

import { ProviderOutputSpeedStateSchema } from "@ai-sidekicks/contracts";

import { AGENTS_SCENARIO } from "./agents.js";
import {
  SWITCH_BOUNDARIES,
  SWITCH_CONTINUITIES,
  SWITCH_STATUSES,
} from "../../agents/agent-wire.js";
import type { ScenarioResolvingReply } from "../scenario.js";

function resolvingReplyFor(call: string): ScenarioResolvingReply {
  const reply = AGENTS_SCENARIO.replies.find((candidate) => candidate.call === call);
  expect(reply, `the scenario scripts no "${call}" reply`).toBeDefined();
  const resolving = reply as ScenarioResolvingReply;
  expect(resolving.result, `"${call}" refuses rather than resolving`).toBeDefined();
  return resolving;
}

describe("the agents scenario", () => {
  it("holds one agent's switch pending, naming the intent it displaced", () => {
    const { agents } = resolvingReplyFor("agent.list").result as {
      agents: readonly {
        pendingSwitch?: { appliesAt: string; replacedSwitchId?: string; pendingAxes: unknown[] };
      }[];
    };
    const pending = agents.flatMap((agent) => (agent.pendingSwitch ? [agent.pendingSwitch] : []));
    // Exactly one, because the wire admits exactly one pending switch per agent and
    // the card renders supersession rather than a queue.
    expect(pending).toHaveLength(1);
    const [onlyPendingSwitch] = pending;
    expect(onlyPendingSwitch).toBeDefined();
    expect(SWITCH_BOUNDARIES).toContain(onlyPendingSwitch?.appliesAt);
    expect(onlyPendingSwitch?.replacedSwitchId).toBeDefined();
    expect(onlyPendingSwitch?.pendingAxes.length).toBeGreaterThan(0);
  });

  it("settles the mutation as applied with its losses declared", () => {
    const settlement = (
      resolvingReplyFor("agent.configUpdate").result as {
        switch: { status: string; continuity?: string; declaredLosses?: readonly string[] };
      }
    ).switch;
    expect(SWITCH_STATUSES).toContain(settlement.status);
    expect(settlement.status).toBe("applied");
    expect(SWITCH_CONTINUITIES).toContain(settlement.continuity);
    // Present AND non-empty: an absent list asserts nothing at all, and an empty one
    // asserts that nothing was dropped — neither is the case this scenario exists
    // to make reachable.
    expect(settlement.declaredLosses?.length).toBeGreaterThan(0);
  });

  it("gives the mutation a latency, so the in-flight rendering is reachable", () => {
    expect(resolvingReplyFor("agent.configUpdate").afterMs).toBeGreaterThan(0);
  });

  it("publishes an output-speed vocabulary only where the flag is declared", () => {
    const { drivers } = resolvingReplyFor("driver.listCapabilities").result as {
      drivers: readonly {
        capabilities: { flags: Record<string, boolean> };
        outputSpeedLevels?: readonly string[];
      }[];
    };
    expect(drivers.length).toBeGreaterThan(1);
    for (const driver of drivers) {
      // The daemon's own composition rule: the member is present iff the flag is
      // true. A fixture that broke the pair would let a control be drawn over a
      // vocabulary the driver never declared.
      expect(driver.outputSpeedLevels !== undefined).toBe(
        driver.capabilities.flags["output_speed"],
      );
    }
  });

  it("carries one model that publishes no effort surface at all", () => {
    const { drivers } = resolvingReplyFor("driver.listModels").result as {
      drivers: readonly { models: readonly { effortLevels?: readonly string[] }[] }[];
    };
    const models = drivers.flatMap((driver) => driver.models);
    // The absent-vocabulary case, which is a different answer from an empty one and
    // is what the effort control's "no control at all" arm is built against.
    expect(models.some((model) => model.effortLevels === undefined)).toBe(true);
    expect(models.some((model) => (model.effortLevels?.length ?? 0) > 0)).toBe(true);
  });

  it("declares the observed output speed in the registered object shape", () => {
    const { agents } = resolvingReplyFor("agent.list").result as {
      agents: readonly { observedOutputSpeed?: unknown }[];
    };
    const observed = agents.flatMap((agent) =>
      agent.observedOutputSpeed === undefined ? [] : [agent.observedOutputSpeed],
    );
    // One row observes and one has not, which is the pair the card's two arms are
    // built against — so the shape check below is over a value that exists.
    expect(observed).toHaveLength(1);
    // The contract's own schema, not a hand-written shape check: this is the
    // parse the daemon's reply would face, and re-stating it here would let the
    // two drift while this file stayed green.
    expect(ProviderOutputSpeedStateSchema.safeParse(observed[0]).success).toBe(true);
  });

  it("negative control: the bare string the fixture used to script does not parse", () => {
    // The value this file shipped before, kept only here. It is what an untyped
    // scripted reply admits, and `.declared` on it is `undefined` — which is what
    // the card rendered. A type-level `satisfies` alone could not fail a test run.
    expect(ProviderOutputSpeedStateSchema.safeParse("standard").success).toBe(false);
  });

  it("scripts no reply for a call it does not make", () => {
    expect(() => resolvingReplyFor("agent.attach")).toThrow();
  });
});

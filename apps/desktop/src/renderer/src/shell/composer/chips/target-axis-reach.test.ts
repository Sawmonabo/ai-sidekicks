// What the chip may offer about the axes, settled without a DOM.
//
// The order of the two checks is the claim, and it is a property of the RESOLUTION
// rather than of the render: a build with no operation behind the popover says so
// whether or not a roster has been read, so this suite drives the arms directly and
// the component suite next door proves each one reaches a sentence.

import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  type AgentRosterEntry,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import type {
  AgentBindingSwitchHolder,
  DriverCatalogHolder,
} from "../../../console/agents/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { AGENT_IMPLEMENTER } from "../../../console/bridge/scenarios/composer.identifiers.js";
import { failedSwitchOf, resolveTargetAxisReach } from "./target-axis-reach.js";

/**
 * One growth port with a named operation absent.
 *
 * Rebuilt rather than deleted from: the port's members are readonly, and a cast that
 * made `delete` compile would also switch off the check that the name is a real
 * operation — which is the one thing this helper has to get right.
 */
function portWithout(port: ConsoleBridge["growth"], omitted: string): ConsoleBridge["growth"] {
  const remaining = Object.entries(port).filter(([operationId]) => operationId !== omitted);
  return Object.fromEntries(remaining) as ConsoleBridge["growth"];
}

const ROSTER_ROW: AgentRosterEntry = { agentId: AGENT_IMPLEMENTER, name: "Implementer" };

/** A catalog holder standing in for a read this suite never performs. */
const CATALOG: DriverCatalogHolder = {
  catalog: { kind: "not-loaded" },
  reopen: () => undefined,
};

/** One latch, with whatever the case is about layered on. */
function switching(overrides: Partial<AgentBindingSwitchHolder> = {}): AgentBindingSwitchHolder {
  return {
    isSubmitting: false,
    settlement: undefined,
    refusal: undefined,
    apply: () => undefined,
    ...overrides,
  };
}

/** The shipped fixture, whose growth port carries every registered operation. */
function bridgeCarryingEveryOperation(): ConsoleBridge {
  return createFixtureBridge({ scenario: COMPOSER_SCENARIO });
}

/**
 * The same bridge with the axis mutation taken off its port.
 *
 * A build assembled without the operation, which is what the `unreachable` arm is
 * about. Reached by taking the member off the port rather than by refusing the call:
 * a refusal is an answer, and this arm is about there being nothing to ask.
 */
function bridgeMissingAxisMutation(): ConsoleBridge {
  const bridge = bridgeCarryingEveryOperation();
  return { ...bridge, growth: portWithout(bridge.growth, "agentConfigUpdate") };
}

describe("resolveTargetAxisReach — reachability is settled before the roster is read", () => {
  it("offers the control when the port carries the operation and the roster served", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      ROSTER_ROW,
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("offered");
    expect(reach.reach === "offered" ? reach.control.agent : undefined).toBe(ROSTER_ROW);
  });

  it("says the roster is unread rather than composing a form over nothing", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      undefined,
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("agent-not-read");
  });

  it("is unreachable on a build carrying no such operation, roster or no roster", () => {
    // The negative control for the two cases above: without the first check a chip
    // over a read roster would offer a press that reaches no call at all, and the
    // reading it was offered over would look exactly like the served one.
    const withRoster = resolveTargetAxisReach(
      bridgeMissingAxisMutation(),
      ROSTER_ROW,
      CATALOG,
      switching(),
    );
    const withoutRoster = resolveTargetAxisReach(
      bridgeMissingAxisMutation(),
      undefined,
      CATALOG,
      switching(),
    );

    expect(withRoster.reach).toBe("unreachable");
    expect(withoutRoster.reach).toBe("unreachable");
  });
});

describe("failedSwitchOf — the reply's own status is the discriminator", () => {
  it("names the settlement the wire called failed", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      ROSTER_ROW,
      CATALOG,
      switching({ settlement: { status: "failed", reason: "model_unavailable" } }),
    );

    expect(failedSwitchOf(reach)?.reason).toBe("model_unavailable");
  });

  it("reads no failure off a settled switch that carries a reason on another arm", () => {
    // The negative control for the case above, and the rule it encodes: a `pending`
    // reply may carry members a failed one also carries, so a reader that keyed on
    // the reason rather than on the status would report a switch that is under way
    // as one that did not happen.
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      ROSTER_ROW,
      CATALOG,
      switching({ settlement: { status: "pending", reason: "model_unavailable" } }),
    );

    expect(failedSwitchOf(reach)).toBeUndefined();
  });

  it("reads nothing off an arm that carries no settlement at all", () => {
    expect(failedSwitchOf(undefined)).toBeUndefined();
    expect(failedSwitchOf({ reach: "unreachable" })).toBeUndefined();
    expect(failedSwitchOf({ reach: "agent-not-read" })).toBeUndefined();
  });
});

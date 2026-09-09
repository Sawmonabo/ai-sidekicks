// What the chip may offer about the axes, settled without a DOM.
//
// The order of the checks is the claim, and it is a property of the RESOLUTION
// rather than of the render: a build with no operation behind the popover says so
// whether or not a roster has been read, so this suite drives the arms directly and
// the component suite next door proves each one reaches a sentence.
//
// AND THE FOUR ROSTER PHASES ARE FOUR ARMS. One arm carried all of them, so a read
// that refused and a read nobody had taken were the same state to every reader —
// which is what let the chip say "has not been read" over a daemon that had answered
// and dropped the reason it answered with.

import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type AgentRosterEntry,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import type {
  AgentBindingSwitchHolder,
  DriverCatalogHolder,
} from "../../../console/agents/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { AGENT_IMPLEMENTER } from "../../../console/bridge/scenarios/composer.identifiers.js";
import type { AgentBindingReading } from "./agent-binding-read.js";
import { failedSwitchOf, resolveTargetAxisReach, switchRefusalOf } from "./target-axis-reach.js";

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

/** A daemon-shaped refusal, so the refused arm carries a reason a person can read. */
const ROSTER_REFUSAL: ConsoleRefusal = growthUnavailable("agentList");

/** A catalog holder standing in for a read this suite never performs. */
const CATALOG: DriverCatalogHolder = {
  catalog: { kind: "not-loaded" },
  reopen: () => undefined,
};

/** One reading, in whichever phase the case is about. */
function reading(overrides: Partial<AgentBindingReading> = {}): AgentBindingReading {
  return {
    phase: "read",
    payingAccountLabel: undefined,
    isProviderDefaultAccount: false,
    pendingSwitch: undefined,
    agent: ROSTER_ROW,
    refusal: undefined,
    ...overrides,
  };
}

/** One latch, with whatever the case is about layered on. */
function switching(overrides: Partial<AgentBindingSwitchHolder> = {}): AgentBindingSwitchHolder {
  return {
    isSubmitting: false,
    settled: undefined,
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
      reading(),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("offered");
    expect(reach.reach === "offered" ? reach.control.agent : undefined).toBe(ROSTER_ROW);
  });

  it("is unreachable on a build carrying no such operation, roster or no roster", () => {
    // The negative control for the case above: without the first check a chip over a
    // read roster would offer a press that reaches no call at all, and the reading it
    // was offered over would look exactly like the served one.
    const withRoster = resolveTargetAxisReach(
      bridgeMissingAxisMutation(),
      reading(),
      CATALOG,
      switching(),
    );
    const withoutRoster = resolveTargetAxisReach(
      bridgeMissingAxisMutation(),
      reading({ phase: "not-checked", agent: undefined }),
      CATALOG,
      switching(),
    );

    expect(withRoster.reach).toBe("unreachable");
    expect(withoutRoster.reach).toBe("unreachable");
  });
});

describe("resolveTargetAxisReach — each roster phase is its own arm", () => {
  it("carries the daemon's reason on a read that refused", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading({ phase: "refused", agent: undefined, refusal: ROSTER_REFUSAL }),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("refused");
    expect(reach.reach === "refused" ? reach.refusal : undefined).toBe(ROSTER_REFUSAL);
  });

  it("is still refused when the refusal carried no reason", () => {
    // The reading's phase is what says the read failed; a reason is what the daemon
    // chose to send. A resolver that keyed on the reason would report a read nobody
    // had taken for exactly the refusals that said least.
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading({ phase: "refused", agent: undefined }),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("refused");
    expect(reach.reach === "refused" ? reach.refusal : ROSTER_REFUSAL).toBeUndefined();
  });

  it("says the read is travelling rather than that nobody asked", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading({ phase: "loading", agent: undefined }),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("loading");
  });

  it("says nobody asked when nobody asked", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading({ phase: "not-checked", agent: undefined }),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("not-checked");
  });

  it("separates a served roster holding no such agent from a read that never ran", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading({ agent: undefined }),
      CATALOG,
      switching(),
    );

    expect(reach.reach).toBe("no-such-agent");
  });
});

describe("failedSwitchOf — the reply's own status is the discriminator", () => {
  it("names the settlement the wire called failed", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading(),
      CATALOG,
      switching({ settled: { settlement: { status: "failed", reason: "model_unavailable" } } }),
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
      reading(),
      CATALOG,
      switching({ settled: { settlement: { status: "pending", reason: "model_unavailable" } } }),
    );

    expect(failedSwitchOf(reach)).toBeUndefined();
  });

  it("reads no failure off a round the daemon answered without naming a switch", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading(),
      CATALOG,
      switching({ settled: { settlement: undefined } }),
    );

    expect(failedSwitchOf(reach)).toBeUndefined();
  });

  it("reads nothing off an arm that carries no settlement at all", () => {
    expect(failedSwitchOf(undefined)).toBeUndefined();
    expect(failedSwitchOf({ reach: "unreachable" })).toBeUndefined();
    expect(failedSwitchOf({ reach: "not-checked" })).toBeUndefined();
  });
});

describe("switchRefusalOf — the call not landing is its own fact", () => {
  it("names the refusal the latch settled the round with", () => {
    const reach = resolveTargetAxisReach(
      bridgeCarryingEveryOperation(),
      reading(),
      CATALOG,
      switching({ refusal: ROSTER_REFUSAL }),
    );

    expect(switchRefusalOf(reach)).toBe(ROSTER_REFUSAL);
  });

  it("reads nothing off an arm that offers no control", () => {
    // The negative control: every absence arm carries no latch, so there is no
    // refusal to read off one and none is invented.
    expect(switchRefusalOf(undefined)).toBeUndefined();
    expect(switchRefusalOf({ reach: "unreachable" })).toBeUndefined();
    expect(switchRefusalOf({ reach: "refused", refusal: ROSTER_REFUSAL })).toBeUndefined();
  });
});

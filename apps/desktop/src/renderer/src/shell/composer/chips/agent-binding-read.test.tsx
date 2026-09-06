// What the binding reads say, and what the console does when they say nothing.
//
// The claim worth a unit is the one the fabricated body reads could never make: each
// fact reaches the chip from the wire that carries it, and every arm where a wire
// carries nothing is a stated absence rather than a value the console picked.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
  type GrowthAgentSummary,
  type GrowthOutcome,
} from "../../../console/bridge/index.js";
import { withDaemonCall } from "../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../../../console/bridge/scheduled-read.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { SessionStore } from "../../../console/store/index.js";
import {
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
} from "../../../console/bridge/scenarios/composer.identifiers.js";
import { useAgentBindingReading } from "./agent-binding-read.js";

const AGENT_ID = "agent-implementer";
/** The account the composer scenario's own `providerAccount.list` reply names. */
const SCENARIO_ACCOUNT_ID = "acct-claude-team";
const SCENARIO_ACCOUNT_LABEL = "Claude — team";

/**
 * The shipped fixture with the roster operation answered.
 *
 * A spread over a REAL bridge and not a hand-built object, which is the shape
 * `fixture-bridge.test-support.ts` states for driving one namespace: the account
 * read, the clock, and the scenario stay the fixture's, so what these cases prove is
 * a join across two live seams rather than across two literals.
 */
function bridgeServingRoster(outcome: GrowthOutcome<readonly GrowthAgentSummary[]>): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  return {
    ...bridge,
    growth: { ...bridge.growth, agentList: async () => outcome },
  };
}

/** One roster row, with whatever the case is about layered on. */
function rosterRow(overrides: Partial<GrowthAgentSummary> = {}): GrowthAgentSummary {
  return {
    agentId: AGENT_ID,
    providerAccountId: undefined,
    pendingSwitch: undefined,
    ...overrides,
  };
}

/**
 * A store for the scenario's session, which the reading's triggers are wired to.
 *
 * Empty and un-fed: what these cases drive is the roster read and the join, and the
 * store is here because the session half of the trigger set reads a degraded cause
 * and a timeline off one. Its own triggers are asserted next door in
 * `agent-roster-reading.test.tsx`, over a store that is fed.
 */
function composerSessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: COMPOSER_SCENARIO.sessionId });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

async function readBinding(bridge: ConsoleBridge, agentId: string | undefined) {
  // One store per mount, built OUTSIDE the render callback: a fresh store on every
  // pass would mint a fresh trigger memory on every pass, and the reading would ask
  // again for a signal it had already answered.
  const sessionStore = composerSessionStore();
  const rendered = renderHook(() => useAgentBindingReading(bridge, sessionStore, agentId));
  // The read is scheduled now, so the frozen clock has to reach the deadline before
  // there is an answer to assert. `settleScheduledRead` is the one helper for that.
  await settleScheduledRead(bridge);
  return rendered;
}

describe("useAgentBindingReading — every fact comes from the wire that carries it", () => {
  it("joins the roster's account id with the account plane's own label", async () => {
    const bridge = bridgeServingRoster({
      status: "served",
      value: [rosterRow({ providerAccountId: SCENARIO_ACCOUNT_ID })],
    });

    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.phase).toBe("read");
    expect(result.current.payingAccountLabel).toBe(SCENARIO_ACCOUNT_LABEL);
    // The negative control: the handle never stands in for the label. An id in a
    // chip is an internal identifier a person cannot act on.
    expect(result.current.payingAccountLabel).not.toBe(SCENARIO_ACCOUNT_ID);
    expect(result.current.isProviderDefaultAccount).toBe(false);
  });

  it("reads an absent account id as the provider's registered default paying", async () => {
    const bridge = bridgeServingRoster({ status: "served", value: [rosterRow()] });

    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.isProviderDefaultAccount).toBe(true);
    expect(result.current.payingAccountLabel).toBeUndefined();
  });

  it("carries the pending switch the reply reports, and nothing when it reports none", async () => {
    const pending = {
      switchId: "switch-1",
      appliesAt: "run_boundary",
      interruptRequested: true,
    } as const;
    const served = await readBinding(
      bridgeServingRoster({ status: "served", value: [rosterRow({ pendingSwitch: pending })] }),
      AGENT_ID,
    );
    expect(served.result.current.pendingSwitch).toStrictEqual(pending);

    // The negative control for the chip this replaced: a row with no pending switch
    // produces no pending reading, so the chip has nothing to render — the previous
    // code read a member no daemon sends and so could never distinguish the two.
    const quiet = await readBinding(
      bridgeServingRoster({ status: "served", value: [rosterRow()] }),
      AGENT_ID,
    );
    expect(quiet.result.current.pendingSwitch).toBeUndefined();
  });

  it("asks nothing at all while the composer is addressed at a channel", async () => {
    const { result } = await readBinding(
      bridgeServingRoster({ status: "served", value: [] }),
      undefined,
    );

    expect(result.current.phase).toBe("not-checked");
  });

  it("carries the growth port's own refusal through untouched", async () => {
    // The LIVE bridge answers exactly this: the operation refuses by name and the
    // refusal says which document owes the wire. Re-minting one here would lose the
    // operation, the slate row, and that document — so the refusal is the port's own
    // builder rather than a literal, and the bridge under it is the fixture, which
    // now serves this operation and would otherwise answer the roster.
    const bridge = bridgeServingRoster(growthUnavailable("agentList"));
    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.phase).toBe("refused");
    expect(result.current.refusal?.origin).toBe("growth-port");
    expect(result.current.refusal?.code).toBe("wire-unregistered");
    expect(result.current.payingAccountLabel).toBeUndefined();
  });

  it("reads the shipped scenario's own roster through the fixture bridge", async () => {
    // The reachability this restores, and the reason the case above had to stop using
    // the bare fixture: the port refused `agentList`, so every provider-bound composer
    // took the refused arm and the label join, the pending switch, and the
    // provider-default arm were reachable through no scenario at all. Nothing is
    // stubbed here — the scenario's `agent.list` reply and its `providerAccount.list`
    // reply are joined by the code under test.
    const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    const { result } = await readBinding(bridge, AGENT_IMPLEMENTER);

    expect(result.current.phase).toBe("read");
    expect(result.current.refusal).toBeUndefined();
    expect(result.current.payingAccountLabel).toBe(SCENARIO_ACCOUNT_LABEL);
    expect(result.current.isProviderDefaultAccount).toBe(false);

    // The other arm of the same cast, from the same read: the reviewer's row names no
    // account, which IS the provider's registered default paying. A scenario whose
    // whole cast took one arm would leave the other drawn by nothing.
    const reviewer = await readBinding(bridge, AGENT_REVIEWER);
    expect(reviewer.result.current.isProviderDefaultAccount).toBe(true);
    expect(reviewer.result.current.payingAccountLabel).toBeUndefined();
  });

  it("renders no label for an account the registry does not carry, and no refusal", async () => {
    // The join's own absence arm. The account plane served and simply holds no such
    // account, so there is nothing to say about the label and nothing failed — and
    // the handle never stands in for it, which is the rule the join exists to keep.
    const bridge = bridgeServingRoster({
      status: "served",
      value: [rosterRow({ providerAccountId: "acct-not-in-this-registry" })],
    });

    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.phase).toBe("read");
    expect(result.current.payingAccountLabel).toBeUndefined();
    expect(result.current.refusal).toBeUndefined();
    expect(result.current.isProviderDefaultAccount).toBe(false);
  });

  it("carries the account plane's refusal beside a binding the roster did read", async () => {
    // The binding IS read and only the label is missing, so the phase stays `read`
    // and the account plane's own refusal rides beside it. Reporting the whole
    // reading as refused would hide a pending switch the roster did report — which
    // this case asserts directly rather than trusting the phase to imply it.
    const refusingRegistry = withDaemonCall(
      createFixtureBridge({ scenario: COMPOSER_SCENARIO }),
      async (call, forward) => {
        if (call.method === "providerAccount.list") {
          throw new Error("the account registry was unreadable");
        }
        return forward();
      },
    );
    const pending = {
      switchId: "switch-2",
      appliesAt: "run_boundary",
      interruptRequested: false,
    } as const;
    const bridge: ConsoleBridge = {
      ...refusingRegistry.bridge,
      growth: {
        ...refusingRegistry.bridge.growth,
        agentList: async () => ({
          status: "served",
          value: [rosterRow({ providerAccountId: SCENARIO_ACCOUNT_ID, pendingSwitch: pending })],
        }),
      },
    };

    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.phase).toBe("read");
    expect(result.current.payingAccountLabel).toBeUndefined();
    expect(result.current.refusal).toBeDefined();
    expect(result.current.pendingSwitch).toStrictEqual(pending);
  });

  it("reports a served roster that does not list this agent as a read, not a refusal", async () => {
    const bridge = bridgeServingRoster({
      status: "served",
      value: [rosterRow({ agentId: "agent-reviewer" })],
    });

    const { result } = await readBinding(bridge, AGENT_ID);

    expect(result.current.phase).toBe("read");
    expect(result.current.refusal).toBeUndefined();
    expect(result.current.isProviderDefaultAccount).toBe(false);
  });
});

// What the target chip knows about the addressed agent's BINDING, read off wires.
//
// THE DEFECT THIS MODULE EXISTS TO END. Three of the chip's facts — the paying
// account, a pending provider switch, and a switch that failed — were read off
// `ConsoleEntity.body` under member names that appear in no contract, no registry,
// and no document. `body` is an untyped bag, so nothing typechecked them and no
// daemon has ever sent one; the chip's own header claimed every field on it was a
// projection of what the daemon said while three of them were projections of
// nothing. So the reads move to the carriers the corpus actually registers.
//
// THE ROSTER READ IS THE GROWTH PORT'S. `agent.list` is registered in
// `docs/architecture/contracts/api-payload-contracts.md` §`agent.attach /
// agent.detach / agent.configUpdate / agent.list` and in no code package, so it
// fails the reply registry's second admission conjunct and goes through the port,
// whose live implementation refuses by name and says which document owes the wire.
// Its reply carries the two facts this module needs: the EFFECTIVE
// `providerAccountId` (absent = the provider's registered default is paying) and
// `pendingSwitch`, present exactly while a switch is accepted and unapplied —
// re-armed after a daemon restart from the durable agent row, which is why a list
// read is how a client that did not issue the mutation learns one is queued.
//
// THE LABEL IS THE ACCOUNT PLANE'S, AND IT IS A REGISTERED WIRE. `providerAccount.list`
// has a contracts pair, so it goes through `callDaemon` like every other registered
// method. The account id the roster reports is a handle; `displayLabel` is what a
// person reads, and the two are joined here rather than either being rendered alone.
// A label is rendered only when BOTH reads served: an account id whose label has not
// been read is not a label, and the chip says nothing rather than showing a handle.
//
// AND THE FAILED SWITCH IS DELIBERATELY NOT HERE. It has two carriers and this
// console can reach neither. The IMMEDIATE arm is `agent.configUpdate`'s response
// disposition (`switch.status === "failed"`), and this composer issues no
// `agent.configUpdate` — the axis popover is not built, which `TargetChip.tsx` says
// and gives its reason for. The DEFERRED arm rides `agent.provider_switch_failed`,
// an event type `packages/contracts`' `event.ts` does not register (Plan-016 T1.13),
// and a console cannot fold an event the union does not carry. So the pending chip
// stands until the daemon reports through a carrier that exists, the wire is named
// on `Plan-023 §Console growth slate` under `agent-provider-switch-failure`, and
// nothing here invents a third carrier to render it from.

import { useCallback, useEffect } from "react";

import {
  callDaemon,
  type ConsoleBridge,
  type GrowthAgentPendingSwitch,
} from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { useSubjectScopedState } from "../../../console/store/index.js";

/** Where the binding read has got to, on the console's four-arm absence rule. */
export type AgentBindingPhase = "not-checked" | "loading" | "read" | "refused";

/** What one addressed agent's binding reads say, or why they say nothing. */
export interface AgentBindingReading {
  readonly phase: AgentBindingPhase;
  /**
   * The paying account's wire-verbatim label, present only when BOTH reads served
   * AND the roster named an account. Absent with `phase: "read"` and no account id
   * is the provider's registered default paying, which the chip states as such.
   */
  readonly payingAccountLabel: string | undefined;
  /** True when the roster served and named no account for this agent. */
  readonly isProviderDefaultAccount: boolean;
  /** The switch accepted and not yet applied, wire-verbatim. */
  readonly pendingSwitch: GrowthAgentPendingSwitch | undefined;
  /** Why the binding could not be read. Carried, never swallowed. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** Nothing has been asked. The seed for every subject that names no agent. */
const NOTHING_ASKED: AgentBindingReading = Object.freeze({
  phase: "not-checked",
  payingAccountLabel: undefined,
  isProviderDefaultAccount: false,
  pendingSwitch: undefined,
  refusal: undefined,
});

/** A read in flight. Entered once, on the pass that first names an agent. */
const READ_IN_FLIGHT: AgentBindingReading = Object.freeze({ ...NOTHING_ASKED, phase: "loading" });

/**
 * Read the addressed agent's binding, held under the bridge and the agent.
 *
 * `useSubjectScopedState` and not a `useState`: a bridge replacement retires every
 * call made through the old transport, and a reading taken through one is not a
 * reading of what the new one holds. Keying on the agent as well is what makes the
 * render that first sees a different agent read that agent's own seed rather than
 * the previous one's account for a frame.
 */
export function useAgentBindingReading(
  bridge: ConsoleBridge,
  sessionId: string,
  agentId: string | undefined,
): AgentBindingReading {
  const { value, settle } = useSubjectScopedState<AgentBindingReading>(
    bridge,
    agentId === undefined ? undefined : `${sessionId}::${agentId}`,
    () => (agentId === undefined ? NOTHING_ASKED : READ_IN_FLIGHT),
  );
  // `settle` and not `publish`: the effect below is armed once per addressing and
  // publishes from inside a `.then`, which is exactly the caller `settle` exists for
  // — it captures the visit on screen when it is CALLED, so a reading whose agent
  // has moved on is dropped rather than rendered under the agent now addressed.
  const publishSettlement = useCallback(
    (reading: AgentBindingReading) => {
      settle()(reading);
    },
    [settle],
  );
  useEffect(() => {
    if (agentId === undefined) {
      return;
    }
    let isAbandoned = false;
    void readAgentBinding(bridge, sessionId, agentId).then((reading) => {
      if (!isAbandoned) {
        publishSettlement(reading);
      }
    });
    return () => {
      isAbandoned = true;
    };
  }, [bridge, sessionId, agentId, publishSettlement]);
  return value;
}

/**
 * Take both reads and join them.
 *
 * Sequential rather than concurrent, deliberately: the account read is only needed
 * when the roster names an account, so an agent on the provider's default pays for
 * one round trip instead of two, and a refused roster read never fires a second call
 * whose answer nothing would render.
 */
async function readAgentBinding(
  bridge: ConsoleBridge,
  sessionId: string,
  agentId: string,
): Promise<AgentBindingReading> {
  const roster = await bridge.growth.agentList({ sessionId });
  if (roster.status !== "served") {
    // The unavailable arm IS the refusal — `GrowthUnavailable` extends
    // `ConsoleRefusal` — so it is carried through untouched. Re-minting one here
    // would lose the operation, the slate row, and the document that owes the wire.
    return { ...NOTHING_ASKED, phase: "refused", refusal: roster };
  }
  const summary = roster.value.find((candidate) => candidate.agentId === agentId);
  if (summary === undefined) {
    // The roster served and this agent is not on it. A reading and not a refusal:
    // the daemon answered, and what it answered is that this session holds no such
    // agent — which the chip renders as knowing nothing about a binding rather than
    // as a read that failed.
    return { ...NOTHING_ASKED, phase: "read" };
  }
  const read: AgentBindingReading = {
    phase: "read",
    payingAccountLabel: undefined,
    isProviderDefaultAccount: summary.providerAccountId === undefined,
    pendingSwitch: summary.pendingSwitch,
    refusal: undefined,
  };
  if (summary.providerAccountId === undefined) {
    return read;
  }
  const accounts = await callDaemon(bridge, "providerAccount.list", {});
  if (accounts.status !== "served") {
    // The binding IS read — the roster answered — and only the label is missing, so
    // the phase stays `read` and the refusal rides beside it. Reporting the whole
    // reading as refused would hide a pending switch the roster did report.
    return { ...read, refusal: accounts.refusal };
  }
  const account = accounts.value.accounts.find(
    (candidate) => candidate.accountId === summary.providerAccountId,
  );
  return { ...read, payingAccountLabel: account?.displayLabel };
}

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
// fails the reply registry's second admission conjunct and goes through the port.
// Its reply carries the two facts this module needs: the EFFECTIVE
// `providerAccountId` (absent = the provider's registered default is paying) and
// `pendingSwitch`, present exactly while a switch is accepted and unapplied —
// re-armed after a daemon restart from the durable agent row, which is why a list
// read is how a client that did not issue the mutation learns one is queued.
//
// AND IT IS A READING, NOT A ONE-SHOT. `agent-roster-reading.ts` holds the read and
// the four moments it is re-taken at; this module is only the join and the React
// wiring. The split is the one `provider-quota-feed.ts` makes with
// `provider-account-quota.ts`: what one reading SAYS is the class's, how many there
// are and how long each lives is the hook's.
//
// THE LABEL IS THE ACCOUNT PLANE'S, AND THIS MODULE DOES NOT READ IT ITSELF. The
// account id the roster reports is a handle; `displayLabel` is what a person reads,
// and the two are joined here. The labels come off `useProviderQuotas` — the window's
// single account-plane reading, one `providerAccount.list` and one
// `providerAccount.subscribe` tail shared by every surface on this bridge — rather
// than off a `providerAccount.list` of this module's own. Two reads of one node-scoped
// registry are two arrival orders with nothing able to say which is right when a
// removal reaches one of them first, and the composer already holds that reading for
// its rate chips, so the join costs no call and no second subscription.
//
// A label is still rendered only when BOTH reads served: an account id absent from the
// label rows has not been read, and the chip says nothing rather than showing a handle.
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

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  consoleClockFor,
  readRefusalOf,
  useProviderQuotas,
  type ConsoleBridge,
  type GrowthAgentPendingSwitch,
} from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import {
  useReadTriggers,
  useSubjectScopedResource,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../../console/store/index.js";
import {
  AgentRosterReading,
  type AgentBindingPhase,
  type AgentRosterReadout,
} from "./agent-roster-reading.js";

export type { AgentBindingPhase } from "./agent-roster-reading.js";

/**
 * The TERMINAL arm, because `dispose()` ends this reading rather than releasing it.
 *
 * It drops the scheduler and latches a flag every later `requestRead` short-circuits
 * on, so a disposed reading is not a working value a later commit may hold again —
 * which is exactly the pairing `{ dispose, isClosed }` exists to state and the reason
 * the reading it belongs to has to be able to report the state.
 *
 * At module level so the hook's dependency lists compare stable identities across
 * renders rather than a fresh literal each pass.
 */
const rosterReadingDisposal: SubjectScopedDisposal<AgentRosterReading> = {
  dispose: (reading: AgentRosterReading): void => {
    reading.dispose();
  },
  isClosed: (reading: AgentRosterReading): boolean => reading.isDisposed,
};

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

/**
 * Read the addressed agent's binding, kept current for as long as it is addressed.
 *
 * The reading is minted per `(bridge, sessionId, agentId)` and disposed with it: a
 * bridge replacement retires every call made through the old transport, and a
 * reading taken through one is not a reading of what the new one holds. Keying on
 * the agent as well is what makes the render that first sees a different agent read
 * that agent's own seed rather than the previous one's account for a frame.
 *
 * AND IT IS HELD BY `useSubjectScopedResource`, NOT BY `useMemo`. The two look alike
 * and answer different questions. A memo plus an unconditional cleanup effect disposes
 * the reading on React's double-mount and then re-commits the value it just disposed —
 * the memo's dependencies have not moved, so nothing re-mints it — leaving the chip on
 * a reading that refuses every `requestRead` for the life of the window: the corpse
 * `store/subject-scoped-resource.ts` takes a terminal disposal in order to recognise.
 * StrictMode is a deferred opt-in rather than a never (`main.tsx` records it), and a
 * discarded concurrent pass reaches the same state by a second door. The holder
 * additionally closes a reading a pass React threw away opened, which the memo could
 * not: a memo's value is minted in the render and reachable by no cleanup unless that
 * render commits.
 */
export function useAgentBindingReading(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  agentId: string | undefined,
): AgentBindingReading {
  // The window's one account-plane reading, watched rather than re-read. Watched
  // unconditionally, because a hook may not be called conditionally and because the
  // reading is node-scoped and shared: the composer's rate chips already hold it, so
  // a channel-addressed composer joins an open reading instead of opening one.
  const quotas = useProviderQuotas(bridge);
  const { sessionId } = sessionStore;
  const openReading = useCallback(
    () => new AgentRosterReading({ bridge, sessionId, agentId, clock: consoleClockFor(bridge) }),
    [bridge, sessionId, agentId],
  );
  // THE BRIDGE IS THE SUBJECT AND THE ADDRESS IS THE KEY, which is the same identity
  // the memo this replaced declared and not a new one: the bridge is what every call
  // this reading makes travels through, so its replacement is what retires the
  // reading, and the session-and-agent pair is what the reading is ABOUT. A composer
  // addressed at a channel names no agent and takes the pair's own empty half, which
  // is a real address — the reading it opens is the one that answers `not-checked`.
  const { value: reading } = useSubjectScopedResource<AgentRosterReading>(
    bridge,
    `${sessionId}::${agentId ?? ""}`,
    openReading,
    rosterReadingDisposal,
  );
  // All four reasons, from the one place the console wires them. What stood here was
  // an effect armed once per addressing, so a switch queued by a collaborator after
  // this composer mounted never reached the chip.
  useReadTriggers(reading, sessionStore);
  const readout = useSyncExternalStore(
    (onReadoutChanged) => reading.subscribe(onReadoutChanged),
    () => reading.readout,
    () => reading.readout,
  );
  // `readRefusalOf` and not `quotas.readRefusal`: the member says the NEWEST read
  // failed only when the phase agrees, and a consumer reading it bare rendered an
  // account plane's last failure beside rows a later read had already healed.
  const accountReadRefusal = readRefusalOf(quotas);
  return useMemo(
    () => joinAccountLabel(readout, quotas.accountLabels, accountReadRefusal),
    [readout, quotas.accountLabels, accountReadRefusal],
  );
}

/**
 * The roster reading with the account plane's word for its handle joined on.
 *
 * NO LABEL IS NOT A REFUSAL BY ITSELF. An account id the label rows do not carry is
 * one whose registry read has not served — the read may be in flight, or it may have
 * failed — so the label stays absent either way and the chip renders the handle
 * nowhere. The account plane's OWN refusal rides beside the reading when there is
 * one, on the rule this join replaces: the binding IS read, the roster answered, and
 * only the label is missing, so reporting the whole reading as refused would hide a
 * pending switch the roster did report.
 */
function joinAccountLabel(
  roster: AgentRosterReadout,
  accountLabels: ReadonlyMap<string, string>,
  accountReadRefusal: ConsoleRefusal | undefined,
): AgentBindingReading {
  const payingAccountLabel =
    roster.payingAccountId === undefined ? undefined : accountLabels.get(roster.payingAccountId);
  return {
    phase: roster.phase,
    payingAccountLabel,
    isProviderDefaultAccount: roster.isProviderDefaultAccount,
    pendingSwitch: roster.pendingSwitch,
    refusal:
      roster.refusal ??
      (roster.payingAccountId !== undefined && payingAccountLabel === undefined
        ? accountReadRefusal
        : undefined),
  };
}

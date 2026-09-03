// One execution root's change-proposal gate: read, collapsed, and announced once.
//
// EXTRACTED BECAUSE THERE ARE THREE MOUNT SITES, NOT ONE. A workspace has three
// writable execution modes and each materialises a different kind of root — a worktree
// with a record of its own, the mount's own checkout under `branch` mode, and a clone
// row — so the gate is drawn under a worktree row, under a workspace card, and under a
// clone card. This module is what all three mount; the surrounding row is what differs.
// Before it existed the gate lived inside `WorktreeGateRow.tsx` and reached exactly one
// of the three, which left two of the writable modes with no way to read a branch
// context, prepare a proposal, or ask for a reviewed act at all.
//
// COLLAPSED BY DEFAULT, AND THE COLLAPSED LINE IS A READING. The gate's own read starts
// when this component mounts, not when the disclosure opens, so the summary line reports
// what was found rather than inviting a click to find out — the same posture
// `RepoSection` takes for the sidebar, and for the same reason: whether a surface is
// worth opening is a question only a surface that has read can answer.
//
// THE DISCLOSURE IS A NATIVE `<details>`, on `WorktreeCard`'s reasoning: keyboard
// reachable, labelled, and focus-visible with no code, and holding no state beside the
// store for a fact the platform already keeps.
//
// THE SETTLEMENT IS ANNOUNCED ONCE, PER GATE. The sentence comes off the reading, so it
// changes when the arm changes and at no other time, and the component remembers the
// last one it spoke — a re-render, a parent's re-read that lands on the same arm, and a
// disclosure toggle all announce nothing. `polite`, always: a gate settling is not a
// room-wide refusal, which is the only thing `frame/banner-announcements.ts` reserves
// the interrupting lane for.

import { useEffect, useRef } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { RefusalCard, useAnnounce } from "../primitives/index.js";
import type { SessionStore } from "../store/index.js";
import { ProposalGate } from "./ProposalGate.js";
import { useProposalGate } from "./proposal-gate-binding.js";
import { SUBJECT_NOT_ADDRESSABLE, type ProposalGateSubject } from "./proposal-gate-model.js";
import type { ProposalGateReading } from "./proposal-gate-reader.js";
import type { ProposalGateState } from "./proposal-gate-state.js";

export interface ProposalGateDisclosureProps {
  readonly bridge: ConsoleBridge;
  /** Which execution root this gate is about. Its kind decides what can be asked. */
  readonly subject: ProposalGateSubject;
  /** The session the gate's own refresh triggers listen to. Passed down, never reached for. */
  readonly sessionStore: SessionStore;
}

export function ProposalGateDisclosure(props: ProposalGateDisclosureProps): React.JSX.Element {
  const { reading, requestAction } = useProposalGate(
    props.bridge,
    props.subject,
    props.sessionStore,
  );
  useAnnounceOnce(reading.settlement);
  return (
    <details className="meridian-root-gate">
      <summary className="meridian-root-gate__summary">
        Change proposal
        <span className="meridian-root-gate__line">{gateSummaryLine(reading)}</span>
      </summary>
      {/*
        The refusal card is OUTSIDE the gate rather than inside it, because the arm it
        belongs to — `not-checked` — carries no message: the gate says nothing was
        answered and the card says which wire and who owes it, or which key the read
        takes that this root has none of. An arm that carries its own message leaves
        this undefined, so no sentence is printed twice.
      */}
      {reading.refusal === undefined ? null : (
        <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
      )}
      <ProposalGate
        state={reading.state}
        onRequestAction={requestAction}
        actionRefusals={reading.actionRefusals}
        inFlightAction={reading.inFlightAction}
      />
    </details>
  );
}

/**
 * One honest line per reading, for a summary that has room for exactly one.
 *
 * TAKES THE READING AND NOT THE ARM, because one arm covers two different facts. A
 * gate reports `not-checked` both when a registered read has not answered yet and
 * when this root has no key the read takes at all — and the second will never become
 * anything else, so a line reading "not checked" invites a wait for an answer that is
 * not coming. The refusal beside the arm is what separates them.
 */
export function gateSummaryLine(reading: ProposalGateReading): string {
  if (reading.refusal?.code === SUBJECT_NOT_ADDRESSABLE) {
    return "not addressable";
  }
  return armSummaryLine(reading.state);
}

/**
 * One honest line per arm.
 *
 * Total over the six arms by construction rather than by a default branch: an arm
 * added to the state fails to compile here until somebody writes the line for it,
 * which is what stops a seventh arm from silently reading as one of the six.
 */
function armSummaryLine(state: ProposalGateState): string {
  switch (state.kind) {
    case "not-checked":
      return "not checked";
    case "preparing":
      return "reading";
    case "no-context":
      return `no context in ${state.executionMode} mode`;
    case "prepared":
      return state.proposal === undefined ? "context read, no proposal" : "proposal ready";
    case "hosting-unavailable":
      return "hosting unavailable";
    case "refused":
      return "refused";
  }
}

/**
 * Say a sentence the first time it is true, and not again.
 *
 * A ref rather than state: announcing is a side effect and remembering what was said
 * must not itself cause a render, or the surface would re-render once per announcement
 * for a value nothing draws.
 */
function useAnnounceOnce(sentence: string | undefined): void {
  const announce = useAnnounce();
  const lastSpoken = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sentence === undefined || sentence === lastSpoken.current) {
      return;
    }
    lastSpoken.current = sentence;
    announce(sentence, "polite");
  }, [announce, sentence]);
}

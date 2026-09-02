// One execution root, and the change proposal standing behind it.
//
// `Spec-023 §Console Design (Meridian)` §10.3 draws the root and §10.7 draws the gate,
// and this module is the seam that puts the second beneath the first — one gate per
// worktree, because the branch-context read is asked per worktree and a session with
// two agents has two roots, two contexts, and two independent refusals.
//
// COLLAPSED BY DEFAULT, AND THE COLLAPSED LINE IS A READING. The gate's own read
// starts when this row mounts, not when the disclosure opens, so the summary line
// reports what was found rather than inviting a click to find out — the same posture
// `RepoSection` takes for the sidebar, and for the same reason: whether a surface is
// worth opening is a question only a surface that has read can answer.
//
// THE DISCLOSURE IS A NATIVE `<details>`, on `WorktreeCard`'s reasoning: keyboard
// reachable, labelled, and focus-visible with no code, and holding no state beside the
// store for a fact the platform already keeps.
//
// THE SETTLEMENT IS ANNOUNCED ONCE, PER ROW. The sentence comes off the reading, so it
// changes when the arm changes and at no other time, and the row remembers the last
// one it spoke — a re-render, a parent's re-read that lands on the same arm, and a
// disclosure toggle all announce nothing. `polite`, always: a gate settling is not a
// room-wide refusal, which is the only thing `frame/banner-announcements.ts` reserves
// the interrupting lane for.

import { useEffect, useRef } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { Nothing, RefusalCard, useAnnounce } from "../primitives/index.js";
import { ProposalGate } from "./ProposalGate.js";
import { WorktreeCard } from "./WorktreeCard.js";
import { useProposalGate } from "./proposal-gate-binding.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";
import type { ProposalGateState } from "./proposal-gate-state.js";
import type { WorktreeStatusRecord } from "./worktree-model.js";

export interface WorktreeGateRowProps {
  readonly record: WorktreeStatusRecord;
  /**
   * Which workspace this root's gate is asked under.
   *
   * Absent where no registered read pairs the two — `worktree-gate-pairing.ts` owns
   * that rule. The row still draws the root; what it cannot do is ask about it.
   */
  readonly subject?: ProposalGateSubject | undefined;
  /** The sentence an absent subject renders, composed by the pairing module. */
  readonly unpairedReason: string;
  readonly bridge: ConsoleBridge;
  /** The instant the section read at, so an age moves on a re-read and never on a render. */
  readonly nowMilliseconds: number;
}

export function WorktreeGateRow(props: WorktreeGateRowProps): React.JSX.Element {
  return (
    <div className="meridian-worktree-gate-row">
      <WorktreeCard record={props.record} nowMilliseconds={props.nowMilliseconds} />
      {props.subject === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No change proposal has been read for this root."
          detail={props.unpairedReason}
        />
      ) : (
        <WorktreeProposalGate bridge={props.bridge} subject={props.subject} />
      )}
    </div>
  );
}

/**
 * The gate for one root, read and drawn.
 *
 * Its own component rather than a branch inside the row, because the hook that holds
 * the reader may not be called conditionally — and the condition above is a real one:
 * a root whose workspace no read names has nothing to read, so no reader is
 * constructed for it and no call is made.
 */
function WorktreeProposalGate(props: {
  readonly bridge: ConsoleBridge;
  readonly subject: ProposalGateSubject;
}): React.JSX.Element {
  const { reading, requestAction } = useProposalGate(props.bridge, props.subject);
  useAnnounceOnce(reading.settlement);
  return (
    <details className="meridian-worktree-gate">
      <summary className="meridian-worktree-gate__summary">
        Change proposal
        <span className="meridian-worktree-gate__line">{gateSummaryLine(reading.state)}</span>
      </summary>
      {/*
        The refusal card is OUTSIDE the gate rather than inside it, because the arm it
        belongs to — `not-checked` — carries no message: the gate says nothing was
        answered and the card says which wire and who owes it. An arm that carries its
        own message leaves this undefined, so no sentence is printed twice.
      */}
      {reading.refusal === undefined ? null : (
        <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
      )}
      <ProposalGate
        state={reading.state}
        onRequestAction={requestAction}
        actionRefusals={reading.actionRefusals}
      />
    </details>
  );
}

/**
 * One honest line per arm, for a summary that has room for exactly one.
 *
 * Total over the six arms by construction rather than by a default branch: an arm
 * added to the state fails to compile here until somebody writes the line for it,
 * which is what stops a seventh arm from silently reading as one of the six.
 */
export function gateSummaryLine(state: ProposalGateState): string {
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
 * must not itself cause a render, or the row would re-render once per announcement
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

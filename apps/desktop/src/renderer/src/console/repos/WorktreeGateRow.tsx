// One worktree execution root, and the change proposal standing behind it.
//
// `WorktreeCard.tsx` draws the root and `ProposalGateDisclosure.tsx` draws the gate,
// and this module is the seam that puts the second beneath the first — one gate per
// worktree, because the branch-context read is asked per worktree and a session with
// two agents has two roots, two contexts, and two independent refusals.
//
// WHAT THIS ROW OWNS IS THE PAIRING, AND NOTHING ELSE. The disclosure, the reader, the
// collapsed line, and the announcement are the gate's own and are shared with the two
// other roots a workspace can execute in; what is peculiar to a worktree is that its
// record names no workspace, so a gate can only be asked about it where
// `worktree-gate-pairing.ts` licenses the inference. That absence is this file's, and
// it is the reason this row exists at all.

import type { ConsoleBridge } from "../bridge/index.js";
import { Nothing } from "../primitives/index.js";
import type { SessionStore } from "../store/index.js";
import { ProposalGateDisclosure } from "./ProposalGateDisclosure.js";
import { WorktreeCard } from "./WorktreeCard.js";
import type { ProposalGateSubject } from "./proposal-gate-model.js";
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
  /** The session the gate's own refresh triggers listen to. Passed down, never reached for. */
  readonly sessionStore: SessionStore;
  /** The instant the section read at, so an age moves on a re-read and never on a render. */
  readonly nowMilliseconds: number;
}

export function WorktreeGateRow(props: WorktreeGateRowProps): React.JSX.Element {
  return (
    <div className="meridian-root-gate-row">
      <WorktreeCard record={props.record} nowMilliseconds={props.nowMilliseconds} />
      {props.subject === undefined ? (
        // No gate at all, rather than a gate that could not ask: no reader is
        // constructed for a root whose workspace no read names, so no call is made.
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No change proposal has been read for this root."
          detail={props.unpairedReason}
        />
      ) : (
        <ProposalGateDisclosure
          bridge={props.bridge}
          subject={props.subject}
          sessionStore={props.sessionStore}
        />
      )}
    </div>
  );
}

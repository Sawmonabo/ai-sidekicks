// One ephemeral-clone execution root, and the change proposal standing behind it.
//
// The sibling of `WorktreeGateRow.tsx`, and it exists for the same structural reason:
// `EphemeralCloneCard.tsx` draws the root and `ProposalGateDisclosure.tsx` draws the
// gate, and neither should know about the other. What differs is the absence each row
// can hit — and that difference is the whole reason these are two files rather than
// one with a discriminant.
//
// A CLONE NAMES ITS OWN WORKSPACE, SO THERE IS NO PAIRING TO INFER. `ephemeral_clones`
// carries `workspace_id` on the row, where a worktree record names only its mount and
// has to be paired through the roster. So this row has no `worktree-gate-pairing.ts`
// behind it and cannot: the only thing it can be missing is the ROSTER ENTRY for a
// workspace the clone already named, which is a read that did not answer rather than a
// relation the wire declined to state.
//
// THE GATE ITSELF IS SHARED, AND THAT IS DELIBERATE. Whether the branch context can be
// read for this root at all is the subject's own question, answered once in
// `proposal-gate-model.ts` and never re-decided per row — so a clone root and a branch
// root reach the same designed absence through the same code, and neither surface can
// drift into guessing a key the registered read does not take.

import type { ConsoleBridge } from "../../bridge/index.js";
import { Nothing } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import { EphemeralCloneCard } from "../mounts/EphemeralCloneCard.js";
import { RootDisposalConfirmation } from "../mounts/roots/RootDisposalConfirmation.js";
import { ProposalGateDisclosure } from "./ProposalGateDisclosure.js";
import { CLONE_WORKSPACE_UNNAMED_COPY, type ProposalGateSubject } from "./proposal-gate-model.js";
import type { EphemeralCloneStatusRecord } from "../mounts/worktree-model.js";

export interface EphemeralCloneGateRowProps {
  readonly record: EphemeralCloneStatusRecord;
  /**
   * Which workspace this clone's gate is asked under.
   *
   * Absent only where the roster this section read names no such workspace —
   * `ephemeralCloneGateSubject` owns that rule, because the mode the gate would report
   * against lives on the roster row and nowhere else.
   */
  readonly subject?: ProposalGateSubject | undefined;
  readonly bridge: ConsoleBridge;
  /** The session the gate's own refresh triggers listen to. Passed down, never reached for. */
  readonly sessionStore: SessionStore;
  /** The instant the section read at, so a countdown moves on a re-read and never on a render. */
  readonly nowMilliseconds: number;
  /** Read the section again, so a disposed clone's new state reaches this list. */
  readonly onRequestRead: () => void;
}

export function EphemeralCloneGateRow(props: EphemeralCloneGateRowProps): React.JSX.Element {
  return (
    <div className="meridian-root-gate-row">
      <EphemeralCloneCard record={props.record} nowMilliseconds={props.nowMilliseconds} />
      {/*
        OFFERED ON EVERY ROW, on the worktree row's reasoning: the act needs the clone's
        own id and nothing else, and a clone that is already gone answers
        `clone.not_found` rather than being guessed at here.
      */}
      <RootDisposalConfirmation
        bridge={props.bridge}
        kind="ephemeral-clone"
        rootId={props.record.cloneId}
        onSettled={props.onRequestRead}
      />
      {props.subject === undefined ? (
        // No gate at all rather than a gate that could not ask: no reader is built for
        // a root whose workspace the roster does not name, so no call is made.
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No change proposal has been read for this root."
          detail={CLONE_WORKSPACE_UNNAMED_COPY}
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

// The conversational start's slot — the way a run begins from where the
// conversation is happening rather than from the definitions browser.
//
// OWNED BY PLAN-017. Three callers collapse onto one start operation with no new
// start mode: the registered command, the composer's own affordance, and the agent
// leg's withheld callback tool. The console authors none of them. THE SHELL DIES IN
// THE PLAN-017 TASK THAT MOUNTS THE BODY, in the same PR as the mount.
//
// WHO MOUNTS IT, AND WHY IT SITS AT THE FAMILY ROOT RATHER THAN INSIDE A PANE. Two
// surfaces mount it, which is exactly what `owner-slots.ts` says of this slot and of
// no other. The definitions browser offers it beneath the scope groups, where a
// person who has just read the list may start one by describing it. The run pane
// offers it on its empty arm and on no other: a run view with no run "offers the
// start affordance and a route into the definitions browser" — that is the empty
// state as designed — while on every other arm the pane already names a run, and
// offering to start one there would be a second entry point competing with the run in
// front of the operator. Two mounts of one slot must word the reservation once, which
// is what this wrapper is: the copy below is what both of them show.
//
// WHAT THE MOUNT OWES, AS A TYPE — AND THE ONE THING IT REFUSES TO. The session is
// supplied because a start binds to one. The originating channel is NOT: it is
// provenance the client derives from where the conversation is, never typed by a
// person and never supplied by a tool, and it is not an input to the role
// adjudication. So this mount carries no channel, and a body that wanted one would
// have to obtain it from the surface the conversation is actually on.
//
// NOR DOES IT CARRY ELIGIBILITY. The public role matrix — owner yes, collaborator
// yes, runtime contributor no, viewer no — is rendered by the body BESIDE the
// daemon's own message when a start is denied, not consulted by this mount to
// decide whether to offer the control.

import { WorkflowSlotMount } from "./WorkflowSlotMount.js";
import { WORKFLOW_CHAT_START_SLOT } from "./owner-slots.js";

/** What either mounting surface hands the conversational-start body. */
export interface ChatStartMount {
  /**
   * The session a started run binds to, or `undefined` on a route with none.
   *
   * Required-carrying-undefined rather than optional: a pane that could not resolve
   * a session has to say so, and an absent key would read identically to one that
   * simply forgot to look.
   */
  readonly sessionId: string | undefined;
}

/**
 * The body Plan-017 authors: a COMPONENT the mount renders, never a function it
 * calls. `owner-slots.ts` states the reason once for all five slots.
 */
export type ChatStartBody = (mount: ChatStartMount) => React.ReactNode;

export interface ChatStartSlotProps extends ChatStartMount {
  /** The body, once there is one. Absent everywhere here, so the shell stands. */
  readonly body?: ChatStartBody;
}

/** The conversational start, or the honest statement that it is reserved and unbuilt. */
export function ChatStartSlot(props: ChatStartSlotProps): React.JSX.Element {
  const { body, ...mount } = props;
  return (
    <WorkflowSlotMount
      contract={WORKFLOW_CHAT_START_SLOT}
      body={body}
      mount={mount}
      title="Starting a run by talking to it is not built yet."
      detail="Runs start from a definition in the workflows browser. This area is reserved for the command and the composer's own affordance."
    />
  );
}

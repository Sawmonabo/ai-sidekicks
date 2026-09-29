// The conversational start's slot: the way a run begins from where the conversation is
// happening.
//
// Owned by the workflow engine. Three callers collapse onto one start operation with no
// new start mode: the registered command, the composer's own affordance, and the agent
// leg's withheld callback tool. The console authors none of them.
//
// The run pane offers it on its empty arm and on no other: a run view with no run offers
// the start affordance, while on every other arm the pane already names a run and a
// second entry point would compete with it. The session is supplied because a start
// binds to one.
//
// Nor does this mount carry eligibility. The daemon's verdict is rendered by the body
// beside the daemon's message when a start is denied.

import { WorkflowSlotMount } from "../../components/EngineMountPoint.js";

/** What the mounting surface hands the conversational-start body. */
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
 * The body the workflow engine authors: a COMPONENT the mount renders, never a function
 * it calls, because a call would put the body's hooks into the wrapper's hook list.
 */
export type ChatStartBody = (mount: ChatStartMount) => React.ReactNode;

/** The conversational start's props: the mount the body receives, and the body itself. */
export interface ChatStartSlotProps extends ChatStartMount {
  /** The body, once there is one. While it is absent the empty frame stands. */
  readonly body?: ChatStartBody;
}

/** The conversational start's frame, holding the body once there is one. */
export function ChatStartSlot(props: ChatStartSlotProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <WorkflowSlotMount body={body} mount={mount} />;
}

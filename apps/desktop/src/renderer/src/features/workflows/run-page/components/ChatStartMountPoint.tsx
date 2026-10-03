// The conversational start's mount point: how a run begins from where the conversation is
// happening. The workflow engine owns the body; the run pane offers it on its empty arm only,
// since any other arm already names a run. Eligibility is the daemon's verdict, rendered by the
// body, never decided here.

import { EngineMountPoint } from "../../components/EngineMountPoint.js";

/** What the mounting pane hands the conversational-start body. */
export interface ChatStartMount {
  /**
   * The session a started run binds to, or `undefined` on a route with none. Required rather
   * than optional so a pane that could not resolve a session says so.
   */
  readonly sessionId: string | undefined;
}

/**
 * The body the workflow engine authors. It is rendered as a component, never called, so its
 * hooks stay out of the wrapper's hook list.
 */
export type ChatStartBody = (mount: ChatStartMount) => React.ReactNode;

/** The conversational start's props: the mount the body receives, and the body itself. */
export interface ChatStartMountPointProps extends ChatStartMount {
  /** The body, once there is one. While it is absent the empty frame stands. */
  readonly body?: ChatStartBody;
}

/** The conversational start's frame, holding the body once there is one. */
export function ChatStartMountPoint(props: ChatStartMountPointProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <EngineMountPoint body={body} mount={mount} />;
}

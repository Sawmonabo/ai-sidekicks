// The reading the session header renders, named for the question it answers. It sits beside the
// generic read hook so that hook stays free of any one wire's shape.

import { useSessionHeaderRead, type SessionHeaderReadState } from "./useSessionHeaderRead.js";

/** What the header takes from a session's identity read: the display title, where there is one. */
export interface SessionIdentity {
  /** Absent when the session has no name, which is a settled answer. */
  readonly title?: string;
}

/** The call that reads one session's identity. */
export type SessionIdentityReadCall = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<SessionIdentity>;

/**
 * One session's display title, read for as long as the caller is mounted.
 *
 * @consumedBy the session header's title
 */
export function useSessionIdentity(
  read: SessionIdentityReadCall,
  sessionId: string | undefined,
): SessionHeaderReadState<SessionIdentity> {
  return useSessionHeaderRead(read, sessionId);
}

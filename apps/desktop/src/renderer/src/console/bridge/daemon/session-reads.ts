// The session reads the daemon answers, in the shapes the console asks them in: what a
// session is called from `session.read`, and the session's timeline stream re-opened
// after a kept position with `timeline.subscribe`.
//
// The re-subscribe is a call a surface takes as an argument rather than one this module
// makes, so a surface keeps only its own logic and the composition that has a daemon to
// ask supplies the call. The snapshot half of `session.read` is the registry's own
// binding, which `callDaemon` answers through.

/** What a session is called and the state it is in. */
export interface SessionSummary {
  readonly sessionId: string;
  /** Absent until the session names itself after its first completed exchange. */
  readonly title?: string;
  readonly state: string;
}

/**
 * What a re-subscribe asks for: the session, and a position the daemon issued and the
 * store kept. The registered request's two members this console can supply.
 */
export interface TimelineResubscribeRequest {
  readonly sessionId: string;
  readonly afterCursor: string;
}

/**
 * Re-opens the session's timeline stream after a kept position.
 *
 * Resolves with the daemon's acknowledgement; the rows arrive on the subscription the
 * session store already holds. A rejection propagates.
 */
export type TimelineSubscribeCall = (
  request: TimelineResubscribeRequest,
) => Promise<{ readonly subscriptionId: string }>;

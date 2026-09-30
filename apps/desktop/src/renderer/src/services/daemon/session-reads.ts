// The session reads the daemon answers, in the shapes the console asks them in: what a
// session is called, from `session.read`. The snapshot half of `session.read` is the
// registry's own binding, which `callDaemon` answers through.

/**
 * What a session is called and the state it is in.
 *
 * @consumedBy the session header's title read
 */
export interface SessionSummary {
  readonly sessionId: string;
  /** Absent until the session names itself after its first completed exchange. */
  readonly title?: string;
  readonly state: string;
}

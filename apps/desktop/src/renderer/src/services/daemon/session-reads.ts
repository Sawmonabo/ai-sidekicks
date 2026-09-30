// The session reads the daemon answers, in the shapes the console asks them in.

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

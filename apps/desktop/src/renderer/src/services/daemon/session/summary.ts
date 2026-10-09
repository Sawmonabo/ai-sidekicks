// The session reads the daemon answers, in the shapes the app asks them in.

/** What a session is called and the state it is in. */
export interface SessionSummary {
  readonly sessionId: string;
  /**
   * The session's name as the daemon's read carries it; absent until the session names itself
   * after its first completed exchange.
   */
  readonly name?: string;
  readonly state: string;
}

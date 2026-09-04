// When a session store has just come back from a degraded stream.
//
// WHAT A RECONNECT IS, HERE. The console has no wire-level connection state to read
// — what it has is the session store's own sticky degraded flag, which is raised for
// a stream that stopped and is cleared by nothing except a completed re-pull. So the
// moment every surface treats as a reconnect is that flag CLEARING: the stream was
// interrupted, and a read has since re-established the session. It matters because
// events raised while the stream was down are events those surfaces never saw, and a
// projection built out of them stays wrong until something asks again.
//
// Here rather than beside either caller. Two surfaces watch this same transition —
// the approvals pane, whose five lifecycle events are the only thing that tells it an
// approval was created or resolved, and the node's driver-capability read, whose
// declarations are the nearest thing the console has to a reading of a daemon that
// went away and came back — and two copies of one transition rule drift in the
// direction nothing catches: one of them starts treating the degraded flag's presence
// as the signal and re-reads on every render while the stream is down.
//
// `bridge/` is the lowest family both callers can reach: the flag itself belongs to
// `store/`, which owns no reading of a transition, and the callers sit above.

/**
 * Whether the session store just came back from a degraded stream.
 *
 * A class with a private field rather than a bare ref, because the reading is a
 * TRANSITION and not a value: only the move from a standing cause to none is a
 * reconnect, and a component holding the current cause alone would either re-read on
 * every render while degraded or never read at all.
 *
 * Presence is the whole reading. The cause vocabulary is the store's, and nothing
 * here branches on a member of it — a stream that diverged and a subscription that
 * closed are repaired by the same completed re-pull, and every caller's answer to
 * both is the same read.
 *
 * ONE WATCHER PER SESSION, and it dies with the session it watched. A watcher
 * carrying the previous session's standing flag would read the NEW session's first
 * pass — which is not degraded — as the repair transition, and fire a read nothing
 * had repaired.
 */
export class SessionRepairWatcher {
  #wasDegraded = false;

  /** True exactly on the pass where a standing cause became none. */
  public observe(degradedCause: string | undefined): boolean {
    const isDegraded = degradedCause !== undefined;
    const isRepaired = this.#wasDegraded && !isDegraded;
    this.#wasDegraded = isDegraded;
    return isRepaired;
  }
}

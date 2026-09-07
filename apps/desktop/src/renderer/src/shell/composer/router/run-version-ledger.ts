// The comparand a steer is guarded with, and where the fresh one comes from.
//
// `expectedRunVersion` is MANDATORY and fail-closed on `run.intervene` (D-004-1), and
// the composer used to read it from one place only: the run entity the session store
// projects. That is sound for every advance the wire broadcasts and wrong for the one
// it does not. An APPLIED NATIVE STEER advances the run version without a `run.*`
// state change — `api-payload-contracts.md §Plan-004` says so in terms, which is why
// the response carries `runVersion` at all — so after a successful steer the store's
// projection is one behind, and the next steer sent under it is correctly refused as
// stale. Two steers in a row were impossible without an unrelated run event landing
// between them.
//
// SO THE ANSWER IS READ AND KEPT, AND RECONCILED RATHER THAN PREFERRED. The run also
// advances through the state stream with no intervention pressed at all, so neither
// reading is the fresher on its own: the projection leads after an ordinary
// progression and the answer leads after a native steer. Both are wire figures and
// both are monotonic per run, so the LARGER is the fresher and that is what a steer
// is guarded with. Preferring the kept one unconditionally would pin every later
// steer to the version the last settlement saw — and a refusal carries no
// `runVersion`, so nothing could refresh what it was refused over.
//
// A COMPARAND IS NEVER INVENTED. A run with neither reading answers `undefined`, and
// the router refuses to dispatch rather than sending a zero, which would be a
// stale-replay guard the caller supplied instead of one the daemon verified.
//
// THE SAME RULE IS ENFORCED BY THE RUNS PANE'S OWN DISPATCHER over its six controls.
// It lives in that class's private state and is reachable from nowhere else, and
// constructing that class here would give the composer a second idempotency-key
// source and a second refusal vocabulary for one wire method — so this holds the
// composer's comparands, and the two surfaces guard their own calls.

export class RunVersionLedger {
  readonly #answeredByRunId = new Map<string, number>();

  /**
   * Keep what the daemon answered for one run.
   *
   * Written from EVERY parsed intervention response and not only from the applied
   * ones: a refusal answers with the run's current version too, which is what closes
   * the reject-re-read-retry loop without a re-read. Monotonic, so a response that
   * arrives out of order never walks the comparand backwards.
   */
  public record(runId: string, runVersion: number): void {
    const answered = this.#answeredByRunId.get(runId);
    if (answered === undefined || runVersion > answered) {
      this.#answeredByRunId.set(runId, runVersion);
    }
  }

  /** The comparand to send: the newer of the daemon's last answer and the projection. */
  public comparandFor(runId: string, projectedRunVersion: number | undefined): number | undefined {
    const answered = this.#answeredByRunId.get(runId);
    if (answered === undefined) {
      return projectedRunVersion;
    }
    if (projectedRunVersion === undefined) {
      return answered;
    }
    return Math.max(answered, projectedRunVersion);
  }
}

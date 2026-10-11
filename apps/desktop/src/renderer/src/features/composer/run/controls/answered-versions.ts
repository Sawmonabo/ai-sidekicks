// The comparand a guarded run call carries: `expectedRunVersion` is mandatory on `run.intervene`,
// `run.pause` and `run.resume`. Each answer carries the run's version after the call, and the run
// also advances through the state stream with no call. Neither reading is always fresher, so the
// larger (both are monotonic per run) is used, and a run with neither reading has no comparand
// rather than an invented zero.

/** The newest run version the daemon has answered for each run, used as the comparand. */
export class AnsweredRunVersions {
  readonly #answeredByRunId = new Map<string, number>();

  /**
   * Keep what the daemon answered for one run, from every parsed answer (a rejected
   * intervention carries the current version too). Monotonic: a late answer never lowers it.
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

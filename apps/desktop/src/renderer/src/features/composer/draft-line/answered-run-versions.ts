// The comparand a steer is guarded with: `expectedRunVersion` is mandatory on `run.intervene`.
// An applied native steer advances the run version without a `run.*` event, so the store's
// projection falls one behind; the run also advances through the state stream with no steer.
// Neither reading is always fresher, so the larger (both are monotonic per run) is used, and a
// run with neither reading has no comparand rather than an invented zero.

export class AnsweredRunVersions {
  readonly #answeredByRunId = new Map<string, number>();

  /**
   * Keep what the daemon answered for one run, from every parsed intervention response
   * (a rejected one carries the current version too). Monotonic: a late response never
   * lowers it.
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

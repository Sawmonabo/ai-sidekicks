// The replies a scenario has parked on its frozen clock, and how they come due.
//
// A `ScenarioReply` carrying `afterMs` is a request that has not been answered yet,
// and on a frozen clock the only thing that can answer it is the caller moving that
// clock. Holding them beside the engine rather than in the bridge is what keeps the
// frozen clock the single source of scenario time — a bridge that spent the delay
// itself would be a second clock, and the one property the engine exists for is that
// there is only one.
//
// ITS OWN MODULE rather than a field on the engine, because it owns a rule the engine
// does not otherwise have: entries leave in DUE order, not in call order, so two calls
// made together with different scripted latencies settle in the order a real transport
// would settle them. Keeping that here is what stops `advance` from growing a second
// sort — and it is what keeps the engine itself under this package's file-size rule
// now that the engine has a second thing to publish on every advance.

/**
 * How a held reply ended.
 *
 * Three outcomes rather than a promise that resolves or hangs, because two of
 * them are refusals the caller has to render: an engine torn down under a request
 * and a backlog that is already full both leave the caller with nothing to show,
 * and a promise that never settles leaves a surface loading for the life of the
 * window. The engine reports which; naming the refusal belongs to the bridge.
 */
export type ScenarioReplyOutcome = "due" | "abandoned" | "backlog-full";

/** One reply parked until the frozen clock reaches its tick. */
interface HeldScenarioReply {
  readonly dueAtMs: number;
  readonly settle: (outcome: ScenarioReplyOutcome) => void;
}

/** The replies a scenario is holding, and the bound on how many. */
export class HeldReplyQueue {
  readonly #held: HeldScenarioReply[] = [];
  readonly #cap: number;

  public constructor(cap: number) {
    this.#cap = cap;
  }

  public get heldCount(): number {
    return this.#held.length;
  }

  /** Park one reply. `false` when the queue is already at its cap. */
  public hold(dueAtMs: number, settle: (outcome: ScenarioReplyOutcome) => void): boolean {
    if (this.#held.length >= this.#cap) {
      return false;
    }
    this.#held.push({ dueAtMs, settle });
    return true;
  }

  /**
   * Settle every reply due at or before `elapsedMs`, earliest first.
   *
   * The entries are removed BEFORE any of them is settled, so a continuation that
   * issues another delayed call cannot be released by the same pass that released
   * the call it came from. `sort` is stable, so replies sharing a due tick settle
   * in the order they were made.
   */
  public releaseThrough(elapsedMs: number): void {
    if (this.#held.length === 0) {
      // The common case by far — every advance of a scenario that scripts no
      // latency reaches here — and it allocates nothing.
      return;
    }
    const due: HeldScenarioReply[] = [];
    const stillHeld: HeldScenarioReply[] = [];
    for (const reply of this.#held) {
      (reply.dueAtMs <= elapsedMs ? due : stillHeld).push(reply);
    }
    if (due.length === 0) {
      return;
    }
    this.#held.length = 0;
    this.#held.push(...stillHeld);
    due.sort((left, right) => left.dueAtMs - right.dueAtMs);
    for (const reply of due) {
      reply.settle("due");
    }
  }

  /** Settle every held reply as abandoned. For teardown, and final. */
  public abandonAll(): void {
    const abandoned = this.#held.splice(0, this.#held.length);
    for (const reply of abandoned) {
      reply.settle("abandoned");
    }
  }
}

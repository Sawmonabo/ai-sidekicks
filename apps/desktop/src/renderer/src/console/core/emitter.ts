// The subscribe / emit / unsubscribe idiom, once.
//
// The console grew four of these for one job: a zustand-backed readable store, a
// keyed fan-out in the draft store, a flat sink set in the scenario engine, and a
// single replaceable sink on the tripwire registry. The zustand one is a different
// thing and stays — it backs `useSyncExternalStore` and carries state. The other
// three are this.
//
// Two behaviours are decisions rather than mechanics:
//
//   • **Emission iterates a snapshot.** A sink that unsubscribes another sink
//     during emission must not make that other sink miss the event it was still
//     subscribed for when emission began. Mutating a `Set` while iterating it is
//     defined in JavaScript, which is exactly why the bug is silent.
//   • **A throwing sink does not silence the others.** Every sink runs, and the
//     failures are re-raised together afterwards as an `AggregateError`. Letting
//     the first throw propagate would make delivery depend on subscription order;
//     swallowing would hide a defect in a diagnostic path, which is the one place
//     a hidden defect costs the most.

export type EmitterSink<Event> = (event: Event) => void;

/** Call to stop receiving. Idempotent: calling it twice is not an error. */
export type Unsubscribe = () => void;

export class Emitter<Event> {
  readonly #sinks = new Set<EmitterSink<Event>>();
  readonly #describeWhat: string;

  /**
   * @param describeWhat what is being emitted, for the aggregate failure message —
   *   "tripwire report", "scenario frame". A message that names the stream is the
   *   difference between a debuggable failure and a stack trace in a `Set` loop.
   */
  public constructor(describeWhat: string) {
    this.#describeWhat = describeWhat;
  }

  public subscribe(sink: EmitterSink<Event>): Unsubscribe {
    this.#sinks.add(sink);
    return () => {
      this.#sinks.delete(sink);
    };
  }

  /** Deliver to every sink subscribed when this call began. */
  public emit(event: Event): void {
    const failures: unknown[] = [];
    for (const sink of [...this.#sinks]) {
      try {
        sink(event);
      } catch (sinkFailure: unknown) {
        failures.push(sinkFailure);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${String(failures.length)} sinks failed while receiving a ${this.#describeWhat}`,
      );
    }
  }

  /** How many sinks are attached. Read by tests and by the diagnostics surface. */
  public get sinkCount(): number {
    return this.#sinks.size;
  }

  /** Drop every sink. For teardown, never as a way to "reset" a live emitter. */
  public clear(): void {
    this.#sinks.clear();
  }
}

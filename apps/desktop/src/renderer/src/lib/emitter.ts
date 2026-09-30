// The subscribe / emit / unsubscribe idiom, once. Two behaviors are decisions:
//
//   - Emission iterates a snapshot, so a sink that unsubscribes another during emission does not
//     make it miss an event it was subscribed for when emission began.
//   - A throwing sink does not silence the others: every sink runs and the failures are
//     re-raised together, so delivery does not depend on subscription order and a defect in a
//     diagnostic path is not hidden.

/** A subscriber to an {@link Emitter}. */
export type EmitterSink<Event> = (event: Event) => void;

/** Call to stop receiving. Idempotent: calling it twice is not an error. */
export type Unsubscribe = () => void;

/**
 * A set of sinks that receive every emitted event.
 *
 * `emit` throws when a sink does: the sink's own error if one failed, an `AggregateError` if
 * several did.
 */
export class Emitter<Event> {
  readonly #sinks = new Set<EmitterSink<Event>>();
  readonly #describeWhat: string;

  /** `describeWhat` names the stream in the aggregate failure message, e.g. "tripwire report". */
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

  /** How many sinks are attached. */
  public get sinkCount(): number {
    return this.#sinks.size;
  }

  /** Drop every sink. For teardown, never as a way to "reset" a live emitter. */
  public clear(): void {
    this.#sinks.clear();
  }
}

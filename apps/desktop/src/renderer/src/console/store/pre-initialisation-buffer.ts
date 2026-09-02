// The bounded hold for events that arrive before a store has a base state.
//
// **An event before initialisation is buffered, never applied.** A store with no
// base snapshot cannot tell a first event from a resumed stream, and applying
// against an empty base renders a session that looks complete and is not. Events
// wait here until the read response lands, then drain.
//
// The hold is BOUNDED at `PRE_INITIALISATION_BUFFER_CAP`: a wait longer than a
// handful of events is a read that is not coming rather than a race, and a buffer
// that grew for it would hold a whole session's stream in memory to project none of
// it. Past the bound the oldest is dropped and counted — and the drain re-derives
// exactly which sequences the drop cost, because a hole between the snapshot cursor
// and the oldest survivor is an ordinary gap the reconciler names on its own.

import { PRE_INITIALISATION_BUFFER_CAP } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";

/** Events held for a base state, oldest first, never more than the cap. */
export class PreInitialisationBuffer {
  readonly #held: ConsoleSessionEvent[] = [];
  #dropCount = 0;

  /** Events waiting for a base state. Never more than `PRE_INITIALISATION_BUFFER_CAP`. */
  public get pendingCount(): number {
    return this.#held.length;
  }

  /**
   * Events dropped at the cap over this buffer's life.
   *
   * Counted rather than merely dropped, on the posture the apply queue and the
   * bridge binder already take one layer up: the drop is the correct response to a
   * read that is not coming, but a stream still filling a store nothing can project
   * is a fault upstream, and a count is how it becomes visible before any read
   * lands.
   */
  public get dropCount(): number {
    return this.#dropCount;
  }

  /**
   * Hold one event, answering whether the cap forced an older one out.
   *
   * The OLDEST goes, not the newest. The newest rows are the ones a person is about
   * to look at, and the loss the drop causes is reported either way — as the gap
   * between the snapshot cursor and the oldest survivor.
   */
  public push(event: ConsoleSessionEvent): boolean {
    this.#held.push(event);
    if (this.#held.length <= PRE_INITIALISATION_BUFFER_CAP) {
      return false;
    }
    this.#held.shift();
    this.#dropCount += 1;
    return true;
  }

  /** Take everything held, leaving the buffer empty. */
  public drain(): ConsoleSessionEvent[] {
    return this.#held.splice(0, this.#held.length);
  }
}

// The bounded hold for events that arrive before a store has a base state. An event before
// initialization is buffered, never applied: a store with no base cannot tell a first event from
// a resumed stream, and applying against an empty base renders a session that looks complete and
// is not. Events drain when the read response lands.
//
// The hold is bounded at `PRE_INITIALIZATION_BUFFER_CAP`, since a longer wait is a read that is
// not coming. Past it the oldest is dropped; the drain re-derives what the drop cost, as an
// ordinary gap between the base state cursor and the oldest survivor.

import { PRE_INITIALIZATION_BUFFER_CAP } from "./session-store-caps.js";
import type { ProjectedSessionEvent } from "./entities/entities.js";

/** Events held for a base state, oldest first, never more than the cap. */
export class PreInitializationBuffer {
  readonly #held: ProjectedSessionEvent[] = [];

  /** Events waiting for a base state. Never more than `PRE_INITIALIZATION_BUFFER_CAP`. */
  public get pendingCount(): number {
    return this.#held.length;
  }

  /**
   * Hold one event, answering whether the cap forced an older one out. The oldest goes, since
   * the newest rows are what a person is about to look at; the loss is reported either way, as
   * the gap before the oldest survivor.
   */
  public push(event: ProjectedSessionEvent): boolean {
    this.#held.push(event);
    if (this.#held.length <= PRE_INITIALIZATION_BUFFER_CAP) {
      return false;
    }
    this.#held.shift();
    return true;
  }

  /** Take everything held, leaving the buffer empty. */
  public drain(): ProjectedSessionEvent[] {
    return this.#held.splice(0, this.#held.length);
  }
}

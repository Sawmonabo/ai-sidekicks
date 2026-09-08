// What one session's ledger viewport is showing, and the registry that carries the
// reading across the family DAG.
//
// WHY THIS SITS AT THE FLOOR. The producer is the ledger — a VIEW family, the top of
// the DAG — and the consumer is `frame/session-event-binder.ts`, which composes the
// fixture handle a driver process reads and sits BELOW every view family. The
// consumer therefore cannot import the producer, and the producer must not import
// `frame/index.ts` (that door closes a cycle through `families.ts`). The floor is the
// only home both can reach, which is `transport-reconnect.ts`' reason with the two
// ends swapped.
//
// WHY A LIVE READER AND NOT A PUBLISHED VALUE. Every figure below is scroll geometry
// or a virtualizer computation over it, and the ledger deliberately keeps both off
// its React snapshot — publishing them would notify the tree on every scrolled pixel,
// which is the render the frame's budget exists to avoid. So a mount registers a
// FUNCTION and the reading is taken at the instant somebody asks for one.
//
// LAST WRITER WINS, AND AN UNREGISTER IS IDENTITY-CHECKED. One session can be on
// screen in two places — the session's own ledger and a channel pane's — and a route
// change remounts a pane before React has run the outgoing mount's cleanup. A throwing
// registry would turn either of those into a defect; a blind `delete` on cleanup would
// let the OUTGOING mount remove the incoming one's reader and leave the session
// reading absent for the rest of the window's life. `SessionDiagnosticsHandle.remove`
// makes the same check for the same reason.

import { type Unsubscribe } from "./emitter.js";

/**
 * What a ledger viewport is showing for one session, at one instant.
 *
 * The whole point of the shape is that four of the five figures are the VIEWPORT's
 * and one is the LOG's, so a reader can state the windowing claim as a relation
 * between them rather than against a count from somewhere else entirely.
 */
export interface LedgerWindowReading {
  /** Rows the virtualizer has mounted — the visible range widened by the overscan. */
  readonly mountedRowCount: number;
  /** Rows the window holds and could mount: the virtualizer's own `count`. */
  readonly totalRowCount: number;
  /**
   * How many rows the box itself intersects, WITHOUT the overscan.
   *
   * Zero where nothing has been measured yet, which is the same honest answer the
   * binding's `visibleRange` gives as `undefined` — a box with no measurement
   * intersects no row, and reporting one would invent a window.
   */
  readonly visibleRowCount: number;
  readonly viewportClientHeightPx: number;
  readonly viewportScrollHeightPx: number;
}

/** One mounted viewport's live answer. Called by a reader, never by the ledger. */
export type LedgerWindowReader = () => LedgerWindowReading;

/**
 * Which session's ledger can be read right now.
 *
 * A class with a private field rather than a module-level `Map`, per
 * `apps/desktop/AGENTS.md`: what is registered is state, and the identity check the
 * unregister makes is only meaningful against a remembered value.
 */
export class LedgerWindowDiagnosticsRegistry {
  readonly #readerBySessionId = new Map<string, LedgerWindowReader>();

  /**
   * Publish one mount's reader, and hand back the only way to retire it.
   *
   * The returned function removes THIS reader and not whichever one is current, so
   * a remount that registered before the outgoing mount's cleanup ran keeps its
   * registration.
   */
  public register(sessionId: string, reader: LedgerWindowReader): Unsubscribe {
    this.#readerBySessionId.set(sessionId, reader);
    return () => {
      if (this.#readerBySessionId.get(sessionId) === reader) {
        this.#readerBySessionId.delete(sessionId);
      }
    };
  }

  /** This session's ledger window, or `null` where no viewport is mounted for it. */
  public readingFor(sessionId: string): LedgerWindowReading | null {
    return this.#readerBySessionId.get(sessionId)?.() ?? null;
  }
}

/**
 * The console's registry. One per renderer process, for `consoleTripwires`' reason:
 * an auxiliary window is its own renderer process and therefore its own registry.
 */
export const consoleLedgerWindows: LedgerWindowDiagnosticsRegistry =
  new LedgerWindowDiagnosticsRegistry();

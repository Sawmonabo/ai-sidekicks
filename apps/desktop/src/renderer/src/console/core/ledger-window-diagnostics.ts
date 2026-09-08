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
 * NINE FIGURES, EACH READING EXACTLY ONE THING, and the shape is that wide because
 * the states it has to separate are not orderings of one number. A windowed ledger
 * that shows nothing can be: a viewport the browser measured at no height, a window
 * whose rows the view could not index, a sizer that never received the log's height,
 * or a log that genuinely has nothing in it — and any single count answers all four
 * the same way. Read together they are a set of equations a reader can check:
 * `virtualItemCount` should equal `mountedRowCount`, `totalContentHeightPx` should
 * equal `viewportScrollHeightPx`, `totalRowCount` should equal `indexableRowCount`,
 * and `viewportClientHeightPx` should equal `rangedAgainstClientHeightPx`. A break in
 * any one of them names its own defect — the last one is not hypothetical, and is how
 * the frozen-clock starvation `scroll-chokepoint.ts`' `publishOnResize` closes was
 * found: every other figure agreed while the window ranged against a box from mount.
 */
export interface LedgerWindowReading {
  /** Rows the virtualizer INTENDS on screen: `getVirtualItems().length`. */
  readonly virtualItemCount: number;
  /**
   * Rows actually in the document, counted under the scroll surface.
   *
   * Not the same question as `virtualItemCount` and the pair is the point: the view
   * maps a virtual item to a row and renders NOTHING where it cannot index one, so a
   * window can intend seven rows and mount none. Counted by the index attribute the
   * virtualizer itself resolves an element back through, which is the only marker
   * both sides of that seam agree on.
   */
  readonly mountedRowCount: number;
  /** Rows the window holds and could mount: the virtualizer's own `count`. */
  readonly totalRowCount: number;
  /** Rows the VIEW can index — the published snapshot's own row array length. */
  readonly indexableRowCount: number;
  /**
   * How many rows the box itself intersects, WITHOUT the overscan.
   *
   * Zero where nothing has been measured yet, which is the same honest answer the
   * binding's `visibleRange` gives as `undefined` — a box with no measurement
   * intersects no row, and reporting one would invent a window.
   */
  readonly visibleRowCount: number;
  /**
   * The height the log occupies: the virtualizer's `getTotalSize()`.
   *
   * The sizer is supposed to CARRY this, written to its inline height by the
   * library under `directDomUpdates`, so this figure against
   * `viewportScrollHeightPx` is the one reading that says whether the scrollbar is
   * describing the log or describing whatever happens to be in flow.
   */
  readonly totalContentHeightPx: number;
  /** The scroll element's `clientHeight` — the box the virtualizer ranges against. */
  readonly viewportClientHeightPx: number;
  /** The scroll element's `scrollHeight` — what the browser thinks it contains. */
  readonly viewportScrollHeightPx: number;
  /**
   * The viewport height the VIRTUALIZER is ranging against — the chokepoint's last
   * published sample, which is the only box the library ever sees.
   *
   * Beside `viewportClientHeightPx` rather than instead of it, and the pair is a
   * ninth figure earned the hard way: this reading first took both heights from the
   * sample and reported a 32 px box over 97 px of content while the element was
   * 149 px over 5 085 px. A reading taken from the sample can only ever agree with
   * the window — including when both describe a box that stopped existing — so the
   * instrument was reporting the defect as health. Split, the gap was the defect:
   * the sample was old because nothing was re-publishing it, which is the
   * starvation `scroll-chokepoint.ts`' `publishOnResize` now closes.
   */
  readonly rangedAgainstClientHeightPx: number;
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

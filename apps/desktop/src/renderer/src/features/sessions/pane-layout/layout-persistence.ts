// The pane layout's durable record: its key, the restore gate, and what a save refuses.

import { refuse, type NarrowedRefusal } from "@renderer/lib/refusal.js";
import { PANE_LAYOUT_REFUSAL_ORIGIN } from "./pane-layout-snapshot.js";

/** The durable record the deck's arrangement is saved under, per session. */
export const PANE_LAYOUT_RECORD_KEY = "pane-layout";

/** Why the workspace itself refused. Closed, so a second cause is a decision. */
export const PANE_LAYOUT_SAVE_REFUSAL_CODES = ["layout-save-failed"] as const;

/** One workspace refusal code. Derived, so the vocabulary is declared once. */
export type PaneLayoutSaveRefusalCode = (typeof PANE_LAYOUT_SAVE_REFUSAL_CODES)[number];

/**
 * How far one surface's restore has got, for one arrangement and one session.
 *
 * TWO ANSWERS AND NEITHER IS RENDER STATE. "Has this restore been dispatched" gates
 * an effect, and a flag that re-rendered would re-run the very effect it gates;
 * "has it landed" is read from inside the layout subscription, a callback that
 * outlives the render which installed it, and a captured render value there would be
 * whatever was true when the subscription was made. A mutable holder answers both
 * from wherever they are asked.
 *
 * WHAT IT IS ADDRESSED BY IS THE POINT. Held per `(arrangement, session)` through
 * `store/subject-scoped/subject-scoped-state.ts`, so routing to another open session
 * re-arms it and a `UiStateStore` REPLACEMENT — a reconnect re-mints the store and
 * hands it down without remounting anything — does not. A restore that re-ran there
 * would replace a
 * deck the person has been arranging for minutes with whatever the record holds,
 * which reads as the window silently undoing their work.
 *
 * It owns nothing, so it is a value and not a resource: there is no disposal, and a
 * holder that dropped it needs to do nothing about the one it dropped.
 */
export class RestoreProgress {
  #hasStarted = false;
  #hasSettled = false;

  /** True while no read has been dispatched for this pair. The dispatch gate. */
  public get isUnstarted(): boolean {
    return !this.#hasStarted;
  }

  /** True once the record has been adopted — the moment saving may begin. */
  public get hasSettled(): boolean {
    return this.#hasSettled;
  }

  public start(): void {
    this.#hasStarted = true;
  }

  public settle(): void {
    this.#hasSettled = true;
  }

  /**
   * Give the dispatch gate back, where the read never landed.
   *
   * A read abandoned before it settled — the effect torn down, the strict-mode
   * double mount — has adopted nothing, so the next pass must be free to read again.
   * A settled restore is never re-armed by this: it has already replaced the deck,
   * and reading a second time is what this whole holder exists to prevent.
   */
  public abandon(): void {
    if (!this.#hasSettled) {
      this.#hasStarted = false;
    }
  }
}

/**
 * Raise one, from the closed vocabulary above.
 *
 * `refuse` takes its code as a `string`, so a call site that spelled one wrong
 * would compile and render a code no reader could look up. Everything this surface
 * refuses goes through here instead, where the union is what binds.
 */
export function refusePaneLayoutSave(
  code: PaneLayoutSaveRefusalCode,
  detail: string,
): PaneLayoutSaveRefusal {
  return refuse(PANE_LAYOUT_REFUSAL_ORIGIN, code, detail);
}

/** A typed pane layout save refusal — `core`'s one refusal shape, narrowed on `code`. */
type PaneLayoutSaveRefusal = NarrowedRefusal<PaneLayoutSaveRefusalCode>;

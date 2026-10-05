// The pane layout's saved-record key, its restore gate, and its save refusals.

import { refuse, type NarrowedRefusal } from "@renderer/lib/refusal/refusal.js";
import { PANE_LAYOUT_REFUSAL_ORIGIN } from "./pane-layout-snapshot.js";

/** The durable record the pane layout's arrangement is saved under, per session. */
export const PANE_LAYOUT_RECORD_KEY = "pane-layout";

/** Why a pane layout save refused. */
export const PANE_LAYOUT_SAVE_REFUSAL_CODES = ["layout-save-failed"] as const;

/** One pane layout save refusal code. */
export type PaneLayoutSaveRefusalCode = (typeof PANE_LAYOUT_SAVE_REFUSAL_CODES)[number];

/**
 * How far one screen's restore has got, for one layout and one session.
 *
 * A mutable holder rather than render state: whether the restore was dispatched gates an
 * effect that a re-render would re-run, and whether it landed is read from a subscription
 * callback that outlives the render. It is held per (layout, session), so routing to another
 * session re-arms it and a `UiStateStore` replacement does not; a second restore would replace
 * what the person has been arranging. It owns nothing, so it needs no disposal.
 */
export class RestoreProgress {
  #hasStarted = false;
  #hasSettled = false;

  /** True while no read has been dispatched for this pair. The dispatch gate. */
  public get isUnstarted(): boolean {
    return !this.#hasStarted;
  }

  /** True once the record has been adopted, the moment saving may begin. */
  public get hasSettled(): boolean {
    return this.#hasSettled;
  }

  /** Marks the read dispatched. */
  public start(): void {
    this.#hasStarted = true;
  }

  /** Marks the record adopted. */
  public settle(): void {
    this.#hasSettled = true;
  }

  /**
   * Gives the dispatch gate back when the read never landed (effect torn down, double mount).
   * A settled restore is never re-armed.
   */
  public abandon(): void {
    if (!this.#hasSettled) {
      this.#hasStarted = false;
    }
  }
}

/**
 * Raises a pane layout save refusal. `refuse` takes any string code, so this is where the
 * code union binds.
 */
export function refusePaneLayoutSave(
  code: PaneLayoutSaveRefusalCode,
  detail: string,
): PaneLayoutSaveRefusal {
  return refuse(PANE_LAYOUT_REFUSAL_ORIGIN, code, detail);
}

/** The shared refusal shape, narrowed to this screen's codes. */
type PaneLayoutSaveRefusal = NarrowedRefusal<PaneLayoutSaveRefusalCode>;

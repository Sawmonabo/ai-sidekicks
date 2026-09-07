// The rail's drag gesture — press, scrub, release.
//
// `Spec-023 §Console Design (Meridian)` gives the rail three offers, and the middle
// one was missing: click jumps, the arrows walk, and a DRAG scrubs. The rail bound
// `onPointerMove`, `onPointerLeave`, `onClick` and `onKeyDown` and nothing that
// could tell a press from a hover, so a pointer held down and moved painted a
// fisheye and scrolled nothing.
//
// WHY THE GESTURE IS A CLASS AND NOT THREE `useState` CALLS. A drag is a small state
// machine with three facts that only make sense together — which pointer owns the
// gesture, which mark it last delivered, and whether the click the browser
// synthesizes afterwards has been consumed — and none of them may cause a render.
// Held as component state, every pointer move during a scrub would re-render the
// strip; held here, the gesture publishes only the jumps.
//
// THE ONE-JUMP-PER-MARK RULE IS THE WHOLE POINT. A scrub crosses hundreds of pointer
// positions and a handful of marks, and the ledger's scroll chokepoint is a single
// writer: asking it to jump on every position would queue a write per pointer event
// and animate the ledger into whichever one landed last. So the gesture reports a
// mark only when the drag CROSSES onto a new one, which is also what makes the
// scrub read as one continuous movement rather than as a stutter.
//
// AND THE SYNTHESIZED CLICK IS CONSUMED RATHER THAN RACED. A press and release on
// one element is followed by a `click`, and the rail's click handler jumps — so
// without this the gesture would deliver its mark on the press and again on the
// click. The press records that it handled the gesture and the click takes that
// record once, so a click arriving with no press before it — a synthetic one, or an
// assistive tool's — still jumps exactly as it always has.

import { type RailTick } from "./rail-model.js";

export class RailScrub {
  /** The pointer that owns the gesture, or `undefined` when none does. */
  #activePointerId: number | undefined;
  /** The last mark this gesture delivered, so a re-cross delivers nothing. */
  #deliveredSequence: number | undefined;
  /** Whether a completed press owes the click after it a suppression. */
  #pressOwesClickSuppression = false;

  /** True while a pointer is held down on the strip. */
  public get isScrubbing(): boolean {
    return this.#activePointerId !== undefined;
  }

  /**
   * Begin a gesture.
   *
   * A second press while one is live is ignored rather than adopted: a rail under
   * two simultaneous pointers has no single scrub position, and letting the second
   * take over would make the first's release end a gesture it does not own.
   */
  public begin(pointerId: number): boolean {
    if (this.#activePointerId !== undefined) {
      return false;
    }
    this.#activePointerId = pointerId;
    this.#deliveredSequence = undefined;
    this.#pressOwesClickSuppression = false;
    return true;
  }

  /**
   * The mark this gesture should jump to, or `undefined` when it should not.
   *
   * `undefined` covers three different nothings on purpose — no mark under the
   * pointer, the mark the gesture already delivered, and no gesture at all — because
   * the caller does the same thing in all three: nothing.
   */
  public crossedTo(tick: RailTick | undefined): RailTick | undefined {
    if (!this.isScrubbing || tick === undefined || this.#deliveredSequence === tick.sequence) {
      return undefined;
    }
    this.#deliveredSequence = tick.sequence;
    return tick;
  }

  /**
   * End the gesture this pointer owns.
   *
   * Keyed on the pointer id so a stray release from a pointer that never pressed —
   * a second finger lifting, a capture the platform re-targeted — cannot end
   * somebody else's scrub.
   */
  public end(pointerId: number): void {
    if (this.#activePointerId !== pointerId) {
      return;
    }
    this.#activePointerId = undefined;
    this.#deliveredSequence = undefined;
    this.#pressOwesClickSuppression = true;
  }

  /**
   * Abandon the gesture without owing the click a suppression.
   *
   * A cancelled pointer — the platform took it for a scroll, a pen left the
   * digitizer — synthesizes no click, so recording a debt here would swallow the
   * next real one.
   */
  public cancel(pointerId: number): void {
    if (this.#activePointerId !== pointerId) {
      return;
    }
    this.#activePointerId = undefined;
    this.#deliveredSequence = undefined;
    this.#pressOwesClickSuppression = false;
  }

  /**
   * Whether the click now arriving was synthesized by a press this gesture handled.
   *
   * Consuming, and consuming is what makes it correct: the debt is owed to exactly
   * one click, so a second click with no press before it is not suppressed.
   */
  public takeSynthesizedClick(): boolean {
    const owed = this.#pressOwesClickSuppression;
    this.#pressOwesClickSuppression = false;
    return owed;
  }
}

// What becomes of a value the holder let go of, and what it says about it.
//
// `subject-scoped-holder.ts` answers WHO MAY WRITE and WHICH ADDRESSING A RENDER IS
// READING. This module answers the question that falls out of every write it admits
// or refuses and every addressing it abandons: a value that is not installed is
// reachable through nothing else in the program, and for the caller whose value owns a
// connection, a subscription, or a registry, a silent drop is a leak with no path left
// to it.
//
// THREE MOMENTS, AND THEY REPORT DIFFERENT FACTS.
//
//   • A REFUSED publish settled into a visit that had already ended. That is an
//     anomaly worth an operator's attention on its own — work arrived for a target
//     that is gone — on the precedent `frame/session-event-binder.ts` and
//     `bridge/scenario-runtime/scenario-engine.ts` set for exactly this class.
//   • A REPLACED value is ordinary. Publishing over a held value is how a window
//     replaces a store that closed itself, and reporting it would put a defect on
//     the operator's diagnostics for the substrate working. Only a disposal that
//     THREW is reported there, because a value held by nothing is a different fact
//     from a clean close.
//   • A DISCARDED value was seeded by a render pass that never committed, and is
//     dropped from inside the render that discovers the pass is over. Ordinary too —
//     React throws renders away routinely — so it reports only where the disposal
//     threw, and under the RENDER kind rather than the settlement kind, because that
//     is what an escaping throw would have been recorded as: left to propagate it
//     reaches the surface's error boundary, which records a throw raised while
//     rendering and unmounts the subtree on top of it.
//
// SO WHAT IS SHARED IS THE CLOSE AND NOT THE SENTENCE. One backstopped call, written
// once, because a disposal that throws must not escape into whatever performed the
// publish — a caller's `.then` on one path and its own settlement on the other, and a
// render body on the third — and three sentences, because collapsing them would report
// a routine replacement as an anomaly or an anomaly as routine.
//
// THE REPORT COMES AFTER THE DISPOSAL, and the order is load-bearing: a report THROWS
// in a development build, so reporting first would take the close with it on exactly
// the build an author is watching.
//
// A HOLDER BUILT WITH NO DISPOSAL DROPS WHAT IT LETS GO OF, silently and correctly.
// A value is not a resource, and a console that reported every settlement would put a
// defect on the diagnostics for every route change.
//
// THE VALUE THE LAST COMMIT SAW IS NOT ONE OF THE THREE. It is retired when a later
// render commits, and a live effect is holding it at that moment; handing it here
// would ask a caller to release what it is still reading through.

import { wireRejectionToError } from "../../../../shared/wire-errors.js";

import { reportTripwire } from "../core/index.js";

/** What a tripwire report from this module names as the site it fired at. */
const SITE = "console/store/unheld-value-disposal.ts";

/**
 * How a holder is built, for the caller whose value owns something.
 *
 * A VALUE IS DROPPED AND A RESOURCE IS DISPOSED. A caller that opened a connection
 * for a visit which ended while the open was in flight has published something
 * nothing will ever hold; a caller that published twice before a commit has left the
 * first of the two in the same position; and a render React threw away opened one
 * that no commit will ever reach. None of the three is installed, so no effect closes
 * over any of them, so nothing closes them. Handing a disposal in is what makes those
 * a close rather than a leak.
 */
export interface SubjectScopedHolderOptions<TValue> {
  /**
   * Dispose a direct value the holder is not holding.
   *
   * THREE MOMENTS, ONE SEAM. The value a publish was REFUSED with was never
   * installed; the value a later publish REPLACED is no longer installed; the value a
   * DISCARDED render pass seeded was installed for that pass alone. A caller whose
   * value owns a connection cannot tell those apart from the outside and does not
   * need to: all three are unreachable through the holder, and the only remaining
   * path to any of them is this one.
   *
   * WHETHER THE VALUE MAY BE RELEASED STAYS THE CALLER'S QUESTION. The holder knows a
   * value left its hand and nothing about which render, if any, is holding what — a
   * caller may publish the resource it is already committed to, and closing that one
   * would tear down what the frame on screen reads through.
   * `useSubjectScopedResource` answers it.
   */
  readonly disposeUnheldValue: (unheld: TValue) => void;
}

/** What a caller's disposal did, for the report sentences that differ on it. */
interface DisposalOutcome {
  /** Whether the disposal threw, leaving the value held by nothing at all. */
  readonly threw: boolean;
  /** What it threw, where it did. */
  readonly failure: unknown;
}

/**
 * The caller's disposal, backstopped, with one report sentence per moment.
 *
 * ONE PER HOLDER, taken at construction rather than at each write moment: a publisher
 * is captured per render and a capture may outlive the render that took it, so a
 * disposal supplied beside one would be as stale as the visit it names.
 */
export class UnheldValueDisposal<TValue> {
  readonly #dispose: ((unheld: TValue) => void) | undefined;

  public constructor(dispose: ((unheld: TValue) => void) | undefined) {
    this.#dispose = dispose;
  }

  /**
   * Close a value a publish was refused with, and say that it happened.
   *
   * The report is unconditional here because the fact is: a resource settled into a
   * visit nothing on screen is addressed at. A plain holder reports nothing, because
   * for it the refusal is the drop the substrate is designed around.
   */
  public disposeRefused(refused: TValue): void {
    if (this.#dispose === undefined) {
      return;
    }
    const outcome = this.#hand(refused);
    reportTripwire(
      "apply-chokepoint-bypass",
      SITE,
      outcome.threw
        ? `a resource settled into a subject-scoped visit that had already ended and its disposal threw, so it is installed nowhere and held by nothing: ${wireRejectionToError(outcome.failure, { total: true }).message}`
        : "a resource settled into a subject-scoped visit that had already ended; the holder handed it to the caller's disposal rather than installing it into a visit nothing on screen is addressed at",
    );
  }

  /**
   * Close the value a successful publish replaced, and say nothing where it worked.
   *
   * TWO PUBLISHES BEFORE A COMMIT LEAVE THE FIRST ONE UNREACHABLE, and that is the
   * whole case. The lifetime effect next door closes the value the last commit saw,
   * and the discard path closes what an abandoned pass seeded — neither runs here. So
   * a caller that published B and then C in one batched event left B installed
   * nowhere, held by no effect, and named by nothing: the holder's own write is the
   * last moment anything in the program can reach it.
   */
  public disposeReplaced(replaced: TValue): void {
    const outcome = this.#hand(replaced);
    if (!outcome.threw) {
      return;
    }
    reportTripwire(
      "apply-chokepoint-bypass",
      SITE,
      `a subject-scoped value replaced by a later publish could not be disposed, so it is installed nowhere and held by nothing: ${wireRejectionToError(outcome.failure, { total: true }).message}`,
    );
  }

  /**
   * Close what a render pass seeded and never committed, under the RENDER kind.
   *
   * A pass that addressed a subject the last commit had not seen holds its own
   * addressing until it commits. Where it never does — it suspended, or a later pass
   * superseded it — the value it seeded is named by nothing: no commit reached it, so
   * no effect closed over it, and the addressing it was stamped with is never
   * reissued. The render that discovers the pass is over is its last reachable moment.
   *
   * The kind differs from the two above because the CALLER differs. This runs inside
   * a render body, so a throw left to propagate would have been recorded as a render
   * failure and would have taken the subtree with it; caught here the reading is the
   * same and the subtree survives.
   */
  public disposeDiscarded(discarded: TValue): void {
    const outcome = this.#hand(discarded);
    if (!outcome.threw) {
      return;
    }
    reportTripwire(
      "surface-render-failure",
      SITE,
      `a subject-scoped value seeded by a render pass that never committed could not be disposed, so it is installed nowhere and held by nothing: ${wireRejectionToError(outcome.failure, { total: true }).message}`,
    );
  }

  /**
   * Hand a value over and survive whatever the caller's disposal does.
   *
   * A holder built with no disposal answers as though it returned: a value is
   * dropped, which is the plain holder's whole answer and is correct.
   *
   * `wireRejectionToError` rather than a stringifier of its own: a thrown value is
   * `unknown`, and `String(...)` on a null-prototype one throws inside the report
   * that exists to describe it.
   */
  #hand(unheld: TValue): DisposalOutcome {
    const dispose = this.#dispose;
    if (dispose === undefined) {
      return { threw: false, failure: undefined };
    }
    try {
      dispose(unheld);
      return { threw: false, failure: undefined };
    } catch (failure: unknown) {
      return { threw: true, failure };
    }
  }
}

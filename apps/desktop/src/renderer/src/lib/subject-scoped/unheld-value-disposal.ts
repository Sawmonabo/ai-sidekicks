// What becomes of a value the holder let go of, and what it reports. A value not installed is
// reachable through nothing else, so for a caller whose value owns a connection, subscription or
// registry, a silent drop is a leak.
//
// Three moments report different facts:
//   - A refused publish settled into a visit that had already ended: an anomaly worth an
//     operator's attention, since work arrived for a target that is gone.
//   - A replaced value is ordinary (a window replaces a store that closed itself), so only a
//     disposal that threw is reported, because the value is then held by nothing.
//   - A discarded value was seeded by a render pass that never committed. Also ordinary, so it
//     reports only when the disposal threw, under the render kind, since a throw left to
//     propagate would be recorded as a render failure and unmount the subtree.
//
// What is shared is one backstopped close, since a disposal that throws must not escape into the
// caller's `.then`, its own settlement, or a render body. The sentences stay separate so a routine
// replacement is not reported as an anomaly. The report comes after the disposal, since a report
// throws in a development build and would otherwise take the close with it.
//
// A holder built with no disposal drops silently. The value the last commit saw is not handled
// here: a live effect still holds it, and it is retired when a later render commits.

import { wireRejectionToError } from "../wire-errors.js";

import { reportTripwire } from "../tripwires.js";

/** The site name a tripwire report from this module carries. */
const SITE = "lib/subject-scoped/unheld-value-disposal.ts";

/**
 * How a holder is built, for a caller whose value owns something. A value is dropped but a
 * resource is disposed: a connection opened for a visit that ended, a first publish superseded
 * before a commit, and a render React threw away are all installed nowhere, so no effect closes
 * them. A disposal makes those a close rather than a leak.
 */
export interface SubjectScopedHolderOptions<TValue> {
  /**
   * Disposes a direct value the holder is not holding: one a publish was refused with, one a later
   * publish replaced, or one a discarded render pass seeded. All three are unreachable through
   * the holder. Whether the value may be released stays the caller's question, since the caller
   * may publish the resource it is already committed to; `useSubjectScopedResource` answers it.
   */
  readonly disposeUnheldValue: (unheld: TValue) => void;
}

/**
 * The caller's disposal, backstopped, with one report sentence per moment. One per holder, taken
 * at construction, since a publisher capture may outlive the render that took it.
 */
export class UnheldValueDisposal<TValue> {
  readonly #dispose: ((unheld: TValue) => void) | undefined;

  public constructor(dispose: ((unheld: TValue) => void) | undefined) {
    this.#dispose = dispose;
  }

  /**
   * Closes a value a publish was refused with, and always reports it: a resource settled into a
   * visit nothing on screen is addressed at. A plain holder reports nothing.
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
   * Closes the value a successful publish replaced, reporting only if the disposal threw. Two
   * publishes before a commit leave the first unreachable: neither the lifetime effect in
   * `useSubjectScopedResource.ts` nor the discard path sees it, so the holder's own write is the
   * last moment anything can reach it.
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
   * Closes what a render pass seeded and never committed (it suspended or a later pass superseded
   * it); the render that discovers this is the last moment the value is reachable. Reports under
   * the render kind because it runs inside a render body.
   */
  public disposeDiscarded(discarded: TValue): void {
    const outcome = this.#hand(discarded);
    if (!outcome.threw) {
      return;
    }
    reportTripwire(
      "region-render-failure",
      SITE,
      `a subject-scoped value seeded by a render pass that never committed could not be disposed, so it is installed nowhere and held by nothing: ${wireRejectionToError(outcome.failure, { total: true }).message}`,
    );
  }

  /**
   * Hands a value to the disposal and survives whatever it does; with no disposal the value is
   * dropped. Reports use `wireRejectionToError` because `String(...)` on a null-prototype throw
   * would itself throw inside the report.
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

/** What a caller's disposal did, for the report sentences that differ on it. */
interface DisposalOutcome {
  /** Whether the disposal threw, leaving the value held by nothing at all. */
  readonly threw: boolean;
  /** What it threw, where it did. */
  readonly failure: unknown;
}

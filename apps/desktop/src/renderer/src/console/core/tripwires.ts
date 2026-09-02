// Runtime tripwires.
//
// `Spec-023 §Console Test Tiers` names an architecture tier whose lint tests
// assert the STATIC tripwires (no `scrollTop` write outside the chokepoint, no
// `scrollIntoView`, no runtime `process.env` gate, no `dangerouslySetInnerHTML`
// outside the math-owned node, no direct `window.sidekicks` outside the bridge
// provider, no second mount door for a pane kind, no import from a plan-owned
// subtree, no store reading another store's flag, every `define`-gated module
// unreachable from a release entry). Those are proved by reading source and
// live under `test/console/architecture/`.
//
// This module owns the five tripwires that can only be proved at RUNTIME,
// because their violation is a value rather than a token:
//
//   • `bridge-shape-drift`   — the live and fixture bridges stopped being
//                              shape-identical (I-023-13).
//   • `persistence-value-class` — a write outside the closed UI-state value-class
//                              enumeration reached the store's write chokepoint
//                              (`Spec-023 §Console Design (Meridian)`
//                              §Persistence on the renderer scheme).
//   • `apply-chokepoint-bypass` — a store was mutated outside its single `apply`.
//   • `wire-figure-formatting`  — a wire figure was rendered through something
//                              other than the two classes §The eight rules fixes.
//   • `surface-render-failure`  — a surface threw while RENDERING and its error
//                              boundary caught it. Its own kind rather than a
//                              state-write breach: a component that crashes on a
//                              value it could not render mutated nothing, and
//                              counting it as a chokepoint bypass would report a
//                              store invariant as broken every time a pane hit a
//                              rendering bug — the one reading an operator must be
//                              able to trust.
//
// **Loud in development, reported in production.** A tripwire is a defect
// detector, and a defect detector that crashes an operator's session turns one
// defect into two. In development it throws, so the author sees it at the moment
// they cause it; in a release build it records, counts, and hands the record to
// whatever diagnostic sinks are subscribed. It never silently passes: the record
// exists in both arms.

import { TRIPWIRE_REPORT_CAP } from "./constants.js";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { TRIPWIRE_FIXTURE_GLOBAL } from "./fixture-globals.js";

/**
 * Every runtime tripwire. Closed — adding one is a deliberate edit to this tuple.
 *
 * The tuple is the declaration and `TripwireKind` follows from it. It used to be a
 * hand-written union with this array repeating it: two closed sets that agree until
 * one is widened, and the divergence is invisible to the compiler in exactly the
 * direction that matters — the vacuity guard walks the ARRAY, so a kind added to the
 * union alone would be a tripwire nothing ever checked.
 */
export const TRIPWIRE_KINDS = [
  "bridge-shape-drift",
  "persistence-value-class",
  "apply-chokepoint-bypass",
  "wire-figure-formatting",
  "surface-render-failure",
] as const;

/** One runtime tripwire, derived from the tuple above. */
export type TripwireKind = (typeof TRIPWIRE_KINDS)[number];

/** One tripwire firing. */
export interface TripwireReport {
  readonly kind: TripwireKind;
  /** What was violated, in the imperative the author needs to act on. */
  readonly detail: string;
  /** The site that reported it — a module path or a component name. */
  readonly site: string;
}

/** A sink the shell installs to forward reports to the diagnostic band. */
export type TripwireSink = (report: TripwireReport) => void;

/**
 * Thrown by `reportTripwire` in a development build. Named so a test can assert
 * the tripwire fired rather than asserting on message text.
 */
export class TripwireError extends Error {
  public readonly kind: TripwireKind;
  public readonly site: string;

  public constructor(report: TripwireReport) {
    super(`console tripwire ${report.kind} at ${report.site}: ${report.detail}`);
    this.name = "TripwireError";
    this.kind = report.kind;
    this.site = report.site;
  }
}

/**
 * The console's tripwire recorder.
 *
 * A class rather than module-level mutable state so a test can construct one,
 * drive it, and drop it — module-level state would leak firings between tests and
 * make the vacuity guard unreliable.
 */
export class TripwireRegistry {
  readonly #reports: TripwireReport[] = [];
  readonly #firingCountByKind = new Map<TripwireKind, number>();
  // The subscribe / emit / unsubscribe idiom is `core/emitter.ts`'s, not a fourth
  // hand-rolled copy of it. Delivery is therefore snapshot-iterated and a throwing
  // sink does not silence the others — both of which matter more here than
  // anywhere, because this is the diagnostic path.
  readonly #reportEmitter = new Emitter<TripwireReport>("tripwire report");
  #throwOnReport: boolean;

  public constructor(options: { readonly throwOnReport: boolean } = { throwOnReport: false }) {
    this.#throwOnReport = options.throwOnReport;
  }

  /**
   * Attach a diagnostic sink. Subscribing does not replay past reports, and the
   * returned function is the only way to detach — a registry that could be silently
   * re-pointed would let one subsystem's install drop another's.
   */
  public subscribeToReports(sink: TripwireSink): Unsubscribe {
    return this.#reportEmitter.subscribe(sink);
  }

  /** Whether a report throws. The shell sets this from the build mode at boot. */
  public setThrowOnReport(throwOnReport: boolean): void {
    this.#throwOnReport = throwOnReport;
  }

  /**
   * Record a firing. Throws afterwards in a throwing registry, so the record
   * exists on both arms and a caught `TripwireError` still leaves evidence.
   */
  public report(report: TripwireReport): void {
    this.#firingCountByKind.set(report.kind, (this.#firingCountByKind.get(report.kind) ?? 0) + 1);
    this.#reports.push(report);
    if (this.#reports.length > TRIPWIRE_REPORT_CAP) {
      this.#reports.shift();
    }
    this.#reportEmitter.emit(report);
    if (this.#throwOnReport) {
      throw new TripwireError(report);
    }
  }

  /** Reports retained, oldest first, bounded by `TRIPWIRE_REPORT_CAP`. */
  public reports(): readonly TripwireReport[] {
    return [...this.#reports];
  }

  /** How many times a kind has fired, including firings trimmed from the buffer. */
  public firingCount(kind: TripwireKind): number {
    return this.#firingCountByKind.get(kind) ?? 0;
  }

  /**
   * Forget every firing.
   *
   * Configuration — the subscribed sinks and the throw arm — deliberately survives,
   * because those are how the registry was BUILT and clearing them here would let
   * a test silently disarm the next one. Only the evidence is cleared, which is
   * what a test needs between cases against the process-wide `consoleTripwires`.
   */
  public reset(): void {
    this.#reports.length = 0;
    this.#firingCountByKind.clear();
  }

  /** Total firings across every kind. */
  public get totalFiringCount(): number {
    let total = 0;
    for (const count of this.#firingCountByKind.values()) {
      total += count;
    }
    return total;
  }
}

/**
 * The console's registry. One per renderer process — an auxiliary window is its
 * own renderer process and therefore its own registry, which is the same
 * no-shared-store property I-023-12 states for stores.
 *
 * `import.meta.env.DEV` is a Vite compile-time substitution, not a runtime
 * environment read, so this is not the `process.env` gate the tripwire list
 * forbids.
 */
export const consoleTripwires: TripwireRegistry = new TripwireRegistry({
  throwOnReport: import.meta.env.DEV,
});

/*
 * The property a fixture build hangs the registry on, for the endurance tier.
 *
 * Declared in `core/fixture-globals.ts` and re-exported here, so the module that
 * INSTALLS the handle and the release-absence sweep that proves it absent read one
 * string. Re-exported rather than only imported because the two Electron tiers
 * reach this module by name for it, and a typo on either side would make an
 * assertion silently vacuous — the failure mode that matters most for a check
 * whose whole job is to report nothing most of the time.
 */
export { TRIPWIRE_FIXTURE_GLOBAL };

/*
 * Expose the registry to the page under the fixture define, and only there.
 *
 * The endurance tier drives a real window from outside the renderer, so the only
 * way it can read this registry is through the page. The alternative — letting
 * the tier treat an unreachable registry as "nothing to assert" — is a test that
 * passes whether or not the thing it checks exists, which is worse than not
 * having the test.
 *
 * `__SIDEKICKS_CONSOLE_FIXTURES__` is a literal at build time, so Rollup folds
 * this to nothing in a release bundle: the property does not exist in shipped
 * code, and the architecture tier's release-bundle grep is what keeps that true.
 */
if (__SIDEKICKS_CONSOLE_FIXTURES__) {
  (globalThis as Record<string, unknown>)[TRIPWIRE_FIXTURE_GLOBAL] = consoleTripwires;
}

/** Report to the console's registry. The one call site shape every tripwire uses. */
export function reportTripwire(kind: TripwireKind, site: string, detail: string): void {
  consoleTripwires.report({ kind, site, detail });
}

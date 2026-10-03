// Runtime tripwires: the app's defect detector for a violation whose evidence is a value, not
// a token in the source (a rule decidable by reading the tree belongs in lint). One process-wide
// `TripwireRegistry` per renderer records every firing with a bounded report buffer and an
// unbounded per-kind count, and hands each report to the subscribed diagnostic sinks.
//
// The kinds:
//   - `persistence-value-class`: a write outside the closed UI-state value classes reached the
//     store's write chokepoint.
//   - `apply-chokepoint-bypass`: a store was mutated outside its single `apply`.
//   - `unheld-resource`: a subject-scoped holder let go of a resource it could not install, either
//     one that settled into a visit that had already ended or one whose disposal threw.
//   - `wire-figure-formatting`: a wire figure was rendered outside the two fixed classes.
//   - `region-render-failure`: an error boundary caught a region that threw while rendering. Its
//     own kind, since a render crash mutated no state and is not a store-invariant breach.
//   - `tick-after-teardown`: a scenario engine was asked to advance after it was torn down, so a
//     timer outlived the pane that owned it.
//   - `publish-failure`: a record's change landed and a subscriber threw while it was published,
//     so every view subscribed to it is a step behind.
//
// Loud in development, reported in production: a development build throws so the author sees it
// at once; a release build records and reports without crashing the session. Both arms record.

import { TRIPWIRE_REPORT_CAP } from "./tripwire-caps.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "./emitter.js";

/**
 * Every runtime tripwire. Closed: adding one is a deliberate edit to this tuple, from which
 * `TripwireKind` is derived so the array and the union cannot diverge.
 */
export const TRIPWIRE_KINDS = [
  "persistence-value-class",
  "apply-chokepoint-bypass",
  "unheld-resource",
  "wire-figure-formatting",
  "region-render-failure",
  "tick-after-teardown",
  "publish-failure",
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

/** A sink installed to forward tripwire reports to diagnostics. */
export type TripwireSink = (report: TripwireReport) => void;

/** Thrown by `reportTripwire` in a development build, so a test can assert on the class. */
export class TripwireError extends Error {
  public readonly kind: TripwireKind;
  public readonly site: string;

  public constructor(report: TripwireReport) {
    super(`tripwire ${report.kind} at ${report.site}: ${report.detail}`);
    this.name = "TripwireError";
    this.kind = report.kind;
    this.site = report.site;
  }
}

/**
 * The app's tripwire recorder. A class so a test can construct and drop one instead of
 * leaking firings through module state.
 */
export class TripwireRegistry {
  readonly #reports: TripwireReport[] = [];
  readonly #firingCountByKind = new Map<TripwireKind, number>();
  // `Emitter` delivers to a snapshot of subscribers, and a throwing sink does not silence the
  // others; both matter most on the diagnostic path.
  readonly #reportEmitter = new Emitter<TripwireReport>("tripwire report");
  #throwOnReport: boolean;

  public constructor(options: { readonly throwOnReport: boolean } = { throwOnReport: false }) {
    this.#throwOnReport = options.throwOnReport;
  }

  /**
   * Attaches a diagnostic sink. Past reports are not replayed, and the returned function is the
   * only way to detach, so one subsystem's install cannot drop another's.
   */
  public subscribeToReports(sink: TripwireSink): Unsubscribe {
    return this.#reportEmitter.subscribe(sink);
  }

  /** Sets whether a report throws; the process-wide registry throws in a development build. */
  public setThrowOnReport(throwOnReport: boolean): void {
    this.#throwOnReport = throwOnReport;
  }

  /** Records a firing, then throws in a throwing registry, so a caught error leaves evidence. */
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
   * Forgets every firing. Sinks and the throw setting survive, so a test cannot silently disarm
   * the next one; only the evidence is cleared.
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
 * The app's registry, one per renderer process. Throws in a
 * development build; `import.meta.env.DEV` is a Vite compile-time substitution, not a runtime
 * environment read.
 */
export const windowTripwires: TripwireRegistry = new TripwireRegistry({
  throwOnReport: import.meta.env.DEV,
});

/** Reports to the app's registry; the one call shape every tripwire uses. */
export function reportTripwire(kind: TripwireKind, site: string, detail: string): void {
  windowTripwires.report({ kind, site, detail });
}

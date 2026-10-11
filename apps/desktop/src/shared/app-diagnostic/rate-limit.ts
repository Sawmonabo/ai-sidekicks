// The rate at which app diagnostics go on, so a window that throws on every frame neither fills the
// service's log nor crosses to main every frame. A minute starts at the first record after a quiet
// one; within it each distinct record goes at most three times and all records together at most
// thirty times, and the rest are counted and told as one count once the minute ends. Only a record
// that went is remembered, so the minute holds at most thirty fingerprints. A window applies it
// as it sends to main and main again before it sends a record on.

import type {
  AppCapturedDiagnostic,
  AppDiagnosticHeldBack,
  AppErrorThrown,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";

/** The bounds on how often app diagnostics go on. */
export const APP_DIAGNOSTIC_RATE_BOUNDS = {
  /** The length of one counting window, in milliseconds. */
  windowMs: 60_000,
  /** How often one record goes in a window. */
  perRecord: 3,
  /** How many records in all go in a window. */
  all: 30,
} as const;

/** Arms the end of a counting window after `ms`; the caller picks a timer that suits its process. */
export type CountingWindowTimer = (end: () => void, ms: number) => void;

/** Counts records against the rate and tells how many were held back once each window ends. */
export class DiagnosticRateLimit {
  readonly #onHeldBack: (count: number) => void;
  readonly #armWindowEnd: CountingWindowTimer;
  /** Each record that went in this window, by its fingerprint, and how often. */
  readonly #admitted = new Map<string, number>();
  #admittedCount = 0;
  #heldBackCount = 0;
  #isCounting = false;

  /** `onHeldBack` hears, once a window ends, how many records it held back, when it held any. */
  public constructor(onHeldBack: (count: number) => void, armWindowEnd: CountingWindowTimer) {
    this.#onHeldBack = onHeldBack;
    this.#armWindowEnd = armWindowEnd;
  }

  /**
   * Whether the record with `fingerprint` goes now. One that does not is counted as `weight`
   * records, so a count held back again keeps every record it stood for.
   */
  public admit(fingerprint: string, weight = 1): boolean {
    if (!this.#isCounting) {
      this.#isCounting = true;
      this.#armWindowEnd(() => {
        this.#endWindow();
      }, APP_DIAGNOSTIC_RATE_BOUNDS.windowMs);
    }
    const admittedTimes = this.#admitted.get(fingerprint) ?? 0;
    if (
      admittedTimes >= APP_DIAGNOSTIC_RATE_BOUNDS.perRecord ||
      this.#admittedCount >= APP_DIAGNOSTIC_RATE_BOUNDS.all
    ) {
      this.#heldBackCount += weight;
      return false;
    }
    this.#admitted.set(fingerprint, admittedTimes + 1);
    this.#admittedCount += 1;
    return true;
  }

  #endWindow(): void {
    const heldBackCount = this.#heldBackCount;
    this.#admitted.clear();
    this.#admittedCount = 0;
    this.#heldBackCount = 0;
    this.#isCounting = false;
    if (heldBackCount > 0) {
      this.#onHeldBack(heldBackCount);
    }
  }
}

/** What a fingerprint is taken of: an error, a captured line, or a count of records held back. */
export type FingerprintedDiagnostic =
  | Pick<AppErrorThrown, "kind" | "role" | "name" | "message" | "stack">
  | Pick<AppCapturedDiagnostic, "kind" | "source" | "capturedKind" | "detail">
  | Pick<AppDiagnosticHeldBack, "kind" | "cause" | "count">;

/** What two records of one error or one line share, so a repeat is told from a different one. */
export function fingerprintOf(record: FingerprintedDiagnostic): string {
  if (record.kind === "captured") {
    return JSON.stringify([record.kind, record.source, record.capturedKind, record.detail]);
  }
  if (record.kind === "held-back") {
    return JSON.stringify([record.kind, record.cause]);
  }
  const firstFrame = record.stack?.split("\n", 1)[0] ?? "";
  return JSON.stringify([record.kind, record.role, record.name, record.message, firstFrame]);
}

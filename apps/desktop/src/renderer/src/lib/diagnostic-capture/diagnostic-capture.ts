// The console's always-on error capture: JSONL batching under named caps, a positive marker
// whenever a probe cannot be read, and a forward that carries a batch out of the window. Without
// the marker a blind console looks like a healthy one; without the forward a finding dies with
// the window. A probe the console cannot read is "not checked", never "empty".
//
// It is on in every build, unlike the performance meters in `performance-meters/`, which
// measure a console someone is watching.
//
// It owns no wire: it batches and hands the batch to a forwarder the window composition
// installs, because `lib/` imports nothing above it and each window has its own capture.
//
// Nothing here schedules. A batch leaves when it is full or a caller flushes, so an idle
// process is never woken to check for work.

import type { Clock } from "../clock.js";
import { DIAGNOSTIC_CAPTURE_BOUNDS } from "./diagnostic-capture-bounds.js";

/** How bad one record is. */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/** One severity from {@link DIAGNOSTIC_SEVERITIES}. */
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** One thing the console captured. */
export interface DiagnosticRecord {
  /** When it happened, ISO-8601, from the caller's clock rather than a clock here. */
  readonly at: string;
  readonly severity: DiagnosticSeverity;
  /** The subsystem that captured it — a module path or a registry name. */
  readonly source: string;
  /** What class of thing it is, in the capturing subsystem's own vocabulary. */
  readonly kind: string;
  /** What happened, in the imperative a reader needs to act on. */
  readonly detail: string;
}

/**
 * What the window's composition installs to carry a batch to the daemon's diagnostic band.
 *
 * Takes the JSONL text the band ingests, so there is one encoder. It may throw: the capture
 * then marks the forward seam blind and keeps the batch.
 */
export type DiagnosticBatchForwarder = (jsonLines: string) => void;

/** Detaches a forwarder; inert once another forwarder has replaced it. */
export type DiagnosticForwarderDetach = () => void;

/**
 * A probe the console cannot read, and why: the "I am blind" marker as a value, so a quiet
 * diagnostics view can be told apart from a console that cannot see.
 */
export interface UnreadableProbe {
  readonly probe: string;
  readonly reason: string;
  readonly since: string;
}

/** The source string every record this module mints for itself carries. */
const CAPTURE_SOURCE = "lib/diagnostic-capture";

/** The probe name the forward seam is blind under when no forwarder is installed. */
export const DIAGNOSTIC_FORWARD_PROBE = "diagnostic-band-forward";

/** What a truncated detail ends with, so a reader can tell truncation from brevity. */
const TRUNCATION_SUFFIX = "…";

/** The console's diagnostic capture; a class so a test gets its own. */
export class DiagnosticCapture {
  readonly #pending: DiagnosticRecord[] = [];
  readonly #blindProbes = new Map<string, UnreadableProbe>();
  #forwarder: DiagnosticBatchForwarder | null = null;
  #droppedRecordCount = 0;
  #forwardedRecordCount = 0;
  #refusedBlindProbeCount = 0;

  /**
   * Attach the forwarder that carries batches to the band.
   *
   * Installing flushes what has accumulated, since records captured before wiring finished are
   * boot failures nobody else will see. A second install replaces the first, and the first's
   * detach then does nothing.
   */
  public installForwarder(forwarder: DiagnosticBatchForwarder): DiagnosticForwarderDetach {
    this.#forwarder = forwarder;
    this.#blindProbes.delete(DIAGNOSTIC_FORWARD_PROBE);
    this.flush();
    return () => {
      if (this.#forwarder === forwarder) {
        this.#forwarder = null;
      }
    };
  }

  /** Capture one record. It is stored before any forward, so a throwing forwarder loses nothing. */
  public record(record: DiagnosticRecord): void {
    this.#pending.push({ ...record, detail: boundedDetail(record.detail) });
    while (this.#pending.length > DIAGNOSTIC_CAPTURE_BOUNDS.pendingRecordCount) {
      this.#pending.shift();
      this.#droppedRecordCount += 1;
    }
    if (this.#pending.length >= DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount) {
      this.flush();
    }
  }

  /**
   * Say that a probe cannot be read, and why.
   *
   * Idempotent per probe name, so a permanently unsupported probe does not fill the buffer, and
   * the first marking is also captured as a record. At the bound the refusal is itself
   * announced once by a `probe-blind-set-full` record and counted; the count is incremented
   * before the record is captured, so a re-entrant call does not announce twice. The capture's
   * own forward seam is excluded from that count, as the bounds table explains, so if it is the
   * first refusal past the bound no announcement fires.
   */
  public markBlind(probe: string, reason: string, at: string): void {
    if (this.#blindProbes.has(probe)) {
      return;
    }
    if (this.#blindProbes.size >= DIAGNOSTIC_CAPTURE_BOUNDS.unreadableProbeCount) {
      if (probe === DIAGNOSTIC_FORWARD_PROBE) {
        return;
      }
      this.#refusedBlindProbeCount += 1;
      if (this.#refusedBlindProbeCount === 1) {
        this.record({
          at,
          severity: "warning",
          source: CAPTURE_SOURCE,
          kind: "probe-blind-set-full",
          detail:
            `the blind-probe set is full at ${String(DIAGNOSTIC_CAPTURE_BOUNDS.unreadableProbeCount)} names, ` +
            `so "${probe}" is counted rather than marked and every probe refused after it is counted too. ` +
            "Read refusedBlindProbeCount for the total.",
        });
      }
      return;
    }
    this.#blindProbes.set(probe, { probe, reason, since: at });
    this.record({
      at,
      severity: "warning",
      source: CAPTURE_SOURCE,
      kind: "probe-unsupported",
      detail: `${probe} cannot be read: ${reason}`,
    });
  }

  /** Every probe the console currently cannot read, in the order they went blind. */
  public blindProbes(): readonly UnreadableProbe[] {
    return [...this.#blindProbes.values()];
  }

  /** Whether one named probe is currently blind. */
  public isBlind(probe: string): boolean {
    return this.#blindProbes.has(probe);
  }

  /**
   * Hand what is pending to the forwarder, one bounded batch at a time.
   *
   * With no forwarder the seam is marked blind and the records stay pending under their bound.
   * A batch leaves the buffer only after the forward returns, so a throwing forwarder loses
   * nothing; the seam is then marked blind with the thrown reason.
   */
  public flush(): void {
    const forwarder = this.#forwarder;
    if (forwarder === null) {
      const oldest = this.#pending[0];
      if (oldest !== undefined) {
        this.markBlind(
          DIAGNOSTIC_FORWARD_PROBE,
          "no diagnostic forwarder is installed in this window",
          oldest.at,
        );
      }
      return;
    }
    while (this.#pending.length > 0) {
      const batch = this.#pending.slice(0, DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount);
      try {
        forwarder(toJsonLines(batch));
      } catch (forwardFailure) {
        const reason = forwardFailure instanceof Error ? forwardFailure.message : "unknown failure";
        const oldest = batch[0];
        this.#forwarder = null;
        if (oldest !== undefined) {
          this.markBlind(DIAGNOSTIC_FORWARD_PROBE, reason, oldest.at);
        }
        return;
      }
      this.#pending.splice(0, batch.length);
      this.#forwardedRecordCount += batch.length;
    }
  }

  /** Records held but not yet carried. */
  public get pendingRecordCount(): number {
    return this.#pending.length;
  }

  /** Records dropped because the pending bound was reached. Never silent. */
  public get droppedRecordCount(): number {
    return this.#droppedRecordCount;
  }

  /** Records the forwarder has accepted. */
  public get forwardedRecordCount(): number {
    return this.#forwardedRecordCount;
  }

  /**
   * Blind probes refused because the blind set was full, excluding this module's own forward
   * seam. A count rather than a wider set, like `PerformanceMeterRegistry.refusedSeriesCount`.
   */
  public get refusedBlindProbeCount(): number {
    return this.#refusedBlindProbeCount;
  }
}

/** One record as one JSON line, with a fixed field order so equal records encode alike. */
export function toJsonLine(record: DiagnosticRecord): string {
  return JSON.stringify({
    at: record.at,
    severity: record.severity,
    source: record.source,
    kind: record.kind,
    detail: boundedDetail(record.detail),
  });
}

/** An ISO-8601 stamp from the console's clock, so a frozen clock stamps consistently. */
export function diagnosticStampAt(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** A batch as JSONL: one record per line, newline-separated, no trailing newline. */
export function toJsonLines(records: readonly DiagnosticRecord[]): string {
  return records.map(toJsonLine).join("\n");
}

function boundedDetail(detail: string): string {
  if (detail.length <= DIAGNOSTIC_CAPTURE_BOUNDS.detailCharacterCount) {
    return detail;
  }
  return (
    detail.slice(0, DIAGNOSTIC_CAPTURE_BOUNDS.detailCharacterCount - TRUNCATION_SUFFIX.length) +
    TRUNCATION_SUFFIX
  );
}

/**
 * The console's capture, one per renderer process.
 *
 * Producers are the tripwire route (`tripwire-diagnostic-route.ts`) and warnings a person can
 * do nothing about on screen. Until a forwarder is installed it marks its forward seam blind and
 * holds records under the pending bound.
 */
export const windowDiagnosticCapture: DiagnosticCapture = new DiagnosticCapture();

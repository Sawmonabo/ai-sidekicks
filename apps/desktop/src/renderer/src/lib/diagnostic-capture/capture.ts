// The app's always-on error capture: JSONL batching under named caps, a record whenever a probe
// cannot be read, and a forward that carries a batch out of the window. Without that record an
// app that cannot see looks like a healthy one; without the forward a finding dies with the
// window. A probe the app cannot read is "not checked", never "empty".
//
// It is on in every build, unlike the performance meters in `performance-meters/`, which
// measure an app someone is watching.
//
// It owns no wire: it batches and hands the batch to a forwarder the window composition
// installs, because `lib/` imports nothing above it and each window has its own capture.
//
// Nothing here schedules. A batch leaves when it is full or a caller flushes, so an idle
// process is never woken to check for work.

import type { Clock } from "../clock.js";
import { elideText } from "../elide-text.js";
import { DIAGNOSTIC_CAPTURE_BOUNDS } from "./bounds.js";

/** How bad one record is. */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/** One severity from {@link DIAGNOSTIC_SEVERITIES}. */
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** One thing the app captured. */
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
 * then marks the forward seam unreadable and keeps the batch.
 */
export type DiagnosticBatchForwarder = (jsonLines: string) => void;

/** Detaches a forwarder; inert once another forwarder has replaced it. */
export type DiagnosticForwarderDetach = () => void;

/** The source string every record this module mints for itself carries. */
const CAPTURE_SOURCE = "lib/diagnostic-capture";

/** The probe name the forward seam is unreadable under when no forwarder is installed. */
const DIAGNOSTIC_FORWARD_PROBE = "diagnostic-forward";

/** The app's diagnostic capture; a class so a test gets its own. */
export class DiagnosticCapture {
  readonly #pending: DiagnosticRecord[] = [];
  readonly #unreadableProbes = new Set<string>();
  #forwarder: DiagnosticBatchForwarder | null = null;
  #announcedFullProbeSet = false;

  /**
   * Attach the forwarder that carries batches to the band.
   *
   * Installing flushes what has accumulated, since records captured before wiring finished are
   * boot failures nobody else will see. A second install replaces the first, and the first's
   * detach then does nothing.
   */
  public installForwarder(forwarder: DiagnosticBatchForwarder): DiagnosticForwarderDetach {
    this.#forwarder = forwarder;
    this.#unreadableProbes.delete(DIAGNOSTIC_FORWARD_PROBE);
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
    }
    if (this.#pending.length >= DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount) {
      this.flush();
    }
  }

  /**
   * Hand what is pending to the forwarder, one bounded batch at a time.
   *
   * With no forwarder the seam is marked unreadable and the records stay pending under their
   * bound. A batch leaves the buffer only after the forward returns, so a throwing forwarder
   * loses nothing; the seam is then marked unreadable with the thrown reason.
   */
  public flush(): void {
    const forwarder = this.#forwarder;
    if (forwarder === null) {
      const oldest = this.#pending[0];
      if (oldest !== undefined) {
        this.#markUnreadable(
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
          this.#markUnreadable(DIAGNOSTIC_FORWARD_PROBE, reason, oldest.at);
        }
        return;
      }
      this.#pending.splice(0, batch.length);
    }
  }

  /**
   * Say that a probe cannot be read, and why.
   *
   * Idempotent per probe name, so a permanently unsupported probe does not fill the buffer, and
   * the first marking is captured as a record. At the bound the first refusal is announced once
   * by an `unreadable-probe-set-full` record; the flag is set before the record is captured, so a
   * re-entrant call does not announce twice. The capture's own forward seam is never announced,
   * as the bounds table explains.
   */
  #markUnreadable(probe: string, reason: string, at: string): void {
    if (this.#unreadableProbes.has(probe)) {
      return;
    }
    if (this.#unreadableProbes.size >= DIAGNOSTIC_CAPTURE_BOUNDS.unreadableProbeCount) {
      if (probe === DIAGNOSTIC_FORWARD_PROBE || this.#announcedFullProbeSet) {
        return;
      }
      this.#announcedFullProbeSet = true;
      this.record({
        at,
        severity: "warning",
        source: CAPTURE_SOURCE,
        kind: "unreadable-probe-set-full",
        detail:
          `the unreadable-probe set is full at ` +
          `${String(DIAGNOSTIC_CAPTURE_BOUNDS.unreadableProbeCount)} names, ` +
          `so "${probe}" and every probe refused after it go unrecorded.`,
      });
      return;
    }
    this.#unreadableProbes.add(probe);
    this.record({
      at,
      severity: "warning",
      source: CAPTURE_SOURCE,
      kind: "probe-unsupported",
      detail: `${probe} cannot be read: ${reason}`,
    });
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

/** An ISO-8601 stamp from the app's clock, so a frozen clock stamps consistently. */
export function diagnosticStampAt(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** A batch as JSONL: one record per line, newline-separated, no trailing newline. */
export function toJsonLines(records: readonly DiagnosticRecord[]): string {
  return records.map(toJsonLine).join("\n");
}

function boundedDetail(detail: string): string {
  return elideText(detail, DIAGNOSTIC_CAPTURE_BOUNDS.detailCharacterCount, {
    ellipsisWithinBound: true,
  });
}

/**
 * The app's capture, one per renderer process.
 *
 * Producers are the tripwire route (`tripwire-route.ts`) and warnings a person can
 * do nothing about on screen. Until a forwarder is installed it marks its forward seam unreadable
 * and holds records under the pending bound.
 */
export const windowDiagnosticCapture: DiagnosticCapture = new DiagnosticCapture();

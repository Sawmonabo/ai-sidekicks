// The console's always-on error capture.
//
// `Spec-023 §Console Design (Meridian)` asks for three things together, and they are
// three because each one alone is a capture that lies: JSONL batching under named
// caps, a POSITIVE marker whenever a probe cannot be read, and a forward to the
// daemon's diagnostic band. Batching without the marker reports an empty stream from
// a blind console exactly as it reports one from a healthy console; the marker
// without the forward leaves the finding in the window that is about to be closed.
//
// ALWAYS ON, IN EVERY BUILD. This is the one observability module the fixture define
// does not fold: the perf meters next door measure a console an author is watching,
// and this one captures what happened on a machine nobody was watching. A release
// build that dropped it would ship the console whose failures are unreportable.
//
// IT OWNS NO WIRE, AND THAT IS DELIBERATE. The capture batches and hands the batch
// to a forwarder the shell installs; the forwarder is what knows about the bridge.
// Two reasons. The band is the daemon's, so the module that reaches it belongs with
// the bridge and not at the DAG floor — `core/` imports nothing above it. And an
// auxiliary window is its own renderer process with its own capture and its own
// forwarder, so the seam has to be installable rather than resolved at import.
//
// OWNER. The measurement task of Plan-023 Phase 1C, T-023p-1C-8, on the same reading
// as the perf meters: no task's text names an always-on capture, and the tier that
// would read one is that task's.
//
// NOTHING HERE SCHEDULES. A batch leaves when a batch is full or when a caller
// flushes, never on a timer: a capture that woke an idle process to check whether it
// had anything to say would be spending the budget it exists to report on.

import { DIAGNOSTIC_CAPTURE_BOUNDS } from "./diagnostic-capture-bounds.js";

/** How bad one record is. Closed — the tuple is the declaration. */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "notice"] as const;

/** One severity, derived so the set is declared exactly once. */
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
 * What the shell installs to carry a batch to the daemon's diagnostic band.
 *
 * Takes the JSONL text rather than the records, because JSONL IS the encoding the
 * band ingests and building it here means one encoder rather than one per forwarder.
 * Returns nothing and may throw: a forwarder that fails is a blind probe, and the
 * capture below marks it as one rather than losing the batch quietly.
 */
export type DiagnosticBatchForwarder = (jsonLines: string) => void;

/** Detaches a forwarder. The only way to detach one. */
export type DiagnosticForwarderDetach = () => void;

/**
 * A probe the console cannot read, and why.
 *
 * The "I am blind" marker, as a value rather than as an absence. A surface renders
 * these so an operator reading a quiet diagnostics panel can tell a console with
 * nothing to report from a console that cannot tell.
 */
export interface BlindProbe {
  readonly probe: string;
  readonly reason: string;
  readonly since: string;
}

/** The source string every record this module mints for itself carries. */
const CAPTURE_SOURCE = "console/core/diagnostic-capture";

/** The probe name the forward seam is blind under when no forwarder is installed. */
export const DIAGNOSTIC_BAND_FORWARD_PROBE = "diagnostic-band-forward";

/** What a truncated detail ends with, so a reader can tell truncation from brevity. */
const TRUNCATION_SUFFIX = "…";

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
 * One record as one JSON line.
 *
 * Field order is fixed by the object literal so two records of the same shape encode
 * to the same bytes — which is what makes a captured batch diffable against a
 * recorded one in a test.
 */
export function toJsonLine(record: DiagnosticRecord): string {
  return JSON.stringify({
    at: record.at,
    severity: record.severity,
    source: record.source,
    kind: record.kind,
    detail: boundedDetail(record.detail),
  });
}

/** A batch as JSONL: one record per line, newline-separated, no trailing newline. */
export function toJsonLines(records: readonly DiagnosticRecord[]): string {
  return records.map(toJsonLine).join("\n");
}

/**
 * The console's diagnostic capture.
 *
 * A class rather than module-level state so a test constructs one, drives it, and
 * drops it, and so an auxiliary window gets its own — the same no-shared-state
 * property the console states for stores.
 */
export class DiagnosticCapture {
  readonly #pending: DiagnosticRecord[] = [];
  readonly #blindProbes = new Map<string, BlindProbe>();
  #forwarder: DiagnosticBatchForwarder | null = null;
  #droppedRecordCount = 0;
  #forwardedRecordCount = 0;
  #refusedBlindProbeCount = 0;

  /**
   * Attach the forwarder that carries batches to the band.
   *
   * Installing flushes what has accumulated, because records captured before the
   * shell finished wiring are exactly the boot failures nobody else will see. A
   * second install replaces the first and returns a detach that is inert once
   * replaced — a registry that could be silently re-pointed would let one
   * subsystem's install drop another's.
   */
  public installForwarder(forwarder: DiagnosticBatchForwarder): DiagnosticForwarderDetach {
    this.#forwarder = forwarder;
    this.#blindProbes.delete(DIAGNOSTIC_BAND_FORWARD_PROBE);
    this.flush();
    return () => {
      if (this.#forwarder === forwarder) {
        this.#forwarder = null;
      }
    };
  }

  /**
   * Capture one record.
   *
   * Records first and forwards second, so a throwing forwarder cannot lose the
   * record that was being carried when it threw.
   */
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
   * Say that a probe cannot be read, and why. The "I am blind" marker.
   *
   * Idempotent per probe name: a probe that is unsupported is unsupported on every
   * attempt, and re-marking it on each one would spend the pending buffer restating
   * one fact. The first marking is captured as a record too, so the band learns of
   * the blindness through the same stream as everything else.
   *
   * AT THE BOUND THE REFUSAL IS ITSELF A MARKER, which is what the bounds table next
   * door promises ("none of the three edges is silence") and what the perf-meter
   * registry does with its own refused series. A capture that dropped the
   * thirty-third blind probe in silence would be a module whose whole purpose is
   * telling an operator it cannot see, going quiet at exactly the cascade that filled
   * it. The count is incremented BEFORE the record is captured, so the re-entrant
   * `markBlind` that a batch-boundary flush performs sees a second refusal and does
   * not emit again.
   */
  public markBlind(probe: string, reason: string, at: string): void {
    if (this.#blindProbes.has(probe)) {
      return;
    }
    if (this.#blindProbes.size >= DIAGNOSTIC_CAPTURE_BOUNDS.blindProbeCount) {
      this.#refusedBlindProbeCount += 1;
      if (this.#refusedBlindProbeCount === 1) {
        this.record({
          at,
          severity: "warning",
          source: CAPTURE_SOURCE,
          kind: "probe-blind-set-full",
          detail:
            `the blind-probe set is full at ${String(DIAGNOSTIC_CAPTURE_BOUNDS.blindProbeCount)} names, ` +
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
  public blindProbes(): readonly BlindProbe[] {
    return [...this.#blindProbes.values()];
  }

  /** Whether one named probe is currently blind. */
  public isBlind(probe: string): boolean {
    return this.#blindProbes.has(probe);
  }

  /**
   * Hand what is pending to the forwarder, one bounded batch at a time.
   *
   * With no forwarder installed this is where the capture discovers it is itself
   * blind, and it says so through the marker rather than by dropping the batch: the
   * records stay pending under their bound and go out when a forwarder arrives.
   *
   * A THROWING FORWARDER LOSES NOTHING. The batch is taken from the pending buffer
   * only after the forward returns, so a forwarder that throws leaves its records
   * where they were and the seam is marked blind with the thrown reason.
   */
  public flush(): void {
    const forwarder = this.#forwarder;
    if (forwarder === null) {
      const oldest = this.#pending[0];
      if (oldest !== undefined) {
        this.markBlind(
          DIAGNOSTIC_BAND_FORWARD_PROBE,
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
          this.markBlind(DIAGNOSTIC_BAND_FORWARD_PROBE, reason, oldest.at);
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
   * Blind probes refused because the blind set was already full. Never silent.
   *
   * A count rather than a wider set, on `PerfMeterRegistry.refusedSeriesCount`'
   * reasoning: the number IS the finding, and it says the console went blind in more
   * places than a bounded set can name.
   */
  public get refusedBlindProbeCount(): number {
    return this.#refusedBlindProbeCount;
  }
}

/**
 * The console's capture. One per renderer process, on `consoleTripwires`' reasoning:
 * an auxiliary window is its own renderer process and therefore its own capture.
 *
 * It has one producer and no forwarder. `tripwire-diagnostic-route.ts` routes this
 * process's tripwire registry into it and the composition site arms that route, so
 * every invariant breach a window detects is captured; the forwarder that would carry
 * a batch to the daemon's band is the shell's, and the READING surface — a diagnostics
 * page — is the measurement task's, T-023p-1C-8. Until one of those installs a
 * forwarder the capture marks its own forward seam blind and holds what it has under
 * the pending bound, which is the state its marker exists to make legible.
 */
export const consoleDiagnosticCapture: DiagnosticCapture = new DiagnosticCapture();

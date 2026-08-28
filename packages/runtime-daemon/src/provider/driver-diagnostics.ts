// Driver diagnostics surface (Plan-005 Phase 3, T3.11).
//
// The daemon diagnostic channel both event normalizers route to — the typed
// `DriverDiagnosticRecord`, the emitter that lands each record on the
// structured daemon log stream and on the metrics counters, and the bounded
// reorder buffer whose overflow / pairing-timeout diagnostics are this
// surface's own records (the reorder-and-diagnostics band is one band: the
// buffer's entire OBSERVABLE contract is the diagnostics it emits, so the
// producer lives beside the surface it reports through rather than minting a
// fourth provider-level module the Plan-005 T3.11 Files census does not name).
//
// Deliberately OFF-TIMELINE. Nothing here mints a `session_events` envelope,
// and no record kind is spelled `runtime_node.*` — that prefix is the Spec-006
// event namespace and these records are operator diagnostics by design
// (Plan-005 T3.11 P0-1, Codex round 3). A frame that reaches this surface is
// never silently dropped and never forced into an envelope: it becomes a
// structured log line plus a counter increment, queryable through the
// diagnostics surfaces rather than through the event timeline.
//
// Metrics: the counter NAMES below are the OpenTelemetry instrument names
// (`driver.reorder_buffer.overflow` is pinned verbatim by Plan-005 T3.11
// P2-1). The daemon carries no OpenTelemetry SDK yet — Plan-024's measurement
// substrate owns that wiring and is procurement-blocked (BL-108) — so the
// counter sink is an injected seam: the default in-memory sink keeps exact
// totals (which is what makes the overflow "queryable via those
// diagnostics/metrics surfaces" today), and the Plan-024 substrate binds an
// OTel-backed sink behind the same interface without touching a call site.
//
// Spec coverage: Spec-005 §Required Behavior (the usage-delta, token-partition,
// and thread-routing rules route their diagnostics here); Spec-005 §Pitfalls
// To Avoid (no silent drop, no silent flush); Plan-005 T3.11 P0-1 / P2-1.
//
// Refs: Plan-005 §Phase 3 / T3.11, `Spec-005 §Required Behavior`,
// `docs/plans/006-session-event-taxonomy-and-audit-log.md`
// §Event-Kind Disposition Table.

// --------------------------------------------------------------------------
// Provider identity.
// --------------------------------------------------------------------------

/**
 * The two pinned provider drivers. Defined here — the one provider-neutral
 * surface both normalizers already import — because no narrower home exists:
 * the drivers deliberately never import each other, and `provider-registry.ts`
 * keys drivers by runtime registration rather than by a closed name union.
 */
export type DriverProviderName = "codex" | "claude";

// --------------------------------------------------------------------------
// The typed diagnostic record.
// --------------------------------------------------------------------------

/**
 * The closed set of diagnostic kinds this surface emits.
 *
 * Closed on purpose: the counter-name map below is keyed by this union, so a
 * new diagnostic kind added without a counter name is a compile error rather
 * than an unmetered record. Each kind is owned by a named Plan-005 T3.11 leg:
 *
 *   - `unmapped_wire_kind` — P0-1 default branch: a wire kind outside the
 *     pinned census, or an interim `typePending` kind whose literal has not
 *     landed.
 *   - `payload_variant_pending` — P0-1's second arm: a censused kind whose
 *     target `SessionEventType` has no registered `SessionEventSchema` payload
 *     variant yet, so envelope construction is forbidden (Plan-006 T1.10's
 *     flip-is-not-emission rule).
 *   - `reorder_buffer_overflow` / `tool_pairing_timeout` — P2-1: the bounded
 *     reorder buffer's two never-silent conditions.
 *   - `usage_delta_floor_hit` — the usage-delta rule: an observed decrease on
 *     a declared-cumulative axis is a falsified declaration, floored at zero
 *     and reported, never emitted as negative spend.
 *   - `usage_cross_check_mismatch` — a wire-declared per-turn figure
 *     disagreeing with the derived interval; recorded, never substituted.
 *   - `usage_containment_identity_unconfirmed` — a token breakdown satisfying
 *     no containment identity, emitted unsubtracted (a conservative
 *     overstatement surfaced for repair, never a silent understatement).
 *   - `thread_frame_quarantined` / `thread_quarantine_shed` — the router's
 *     fail-closed refusal band: absent-or-unrecognized identity admissions and
 *     the bounded buffer's oldest-first sheds.
 *   - `thread_pending_hold_shed` — a present-but-unregistered identity whose
 *     registration never landed inside the declared timeout.
 *   - `thread_registration_refused` — a child announcement carrying no
 *     recognized parent linkage; recognition derives from declared lineage,
 *     never from arrival order.
 *   - `thread_child_transcript_suppressed` — first suppression of a registered
 *     child thread's transcript projection (deduplicated per thread so child
 *     content deltas do not flood the channel).
 *
 * The remaining five are owned by named Plan-005 T3.15 legs (callback-tool
 * hosting, leg 3; `subagentPolicy` pass-through, leg 4). They live here rather
 * than on a second diagnostic surface because the closed-union-plus-counter-map
 * pairing above is the property worth keeping: a parallel record type would let
 * a T3.15 refusal go unmetered, which is exactly what this union prevents.
 *
 *   - `callback_tool_seam_absent` — leg 3's runtime backstop: an invocation or
 *     a routed provider ask reached the host while no Plan-012 evaluation seam
 *     is registered. Answered refused, never completed-without-Cedar and never
 *     left unanswered.
 *   - `callback_tool_registry_withheld` — leg 3's fail-closed spawn rule: the
 *     callback-tool registry was withheld from the provider because the daemon
 *     could not guarantee every invocation would be adjudicated.
 *   - `callback_tool_invocation_refused` — an invocation naming no registered
 *     tool, or carrying arguments the registered input schema rejects.
 *     Answered `failed` without ever reaching the approval pipeline.
 *   - `subagent_definition_disabled` — leg 4's fail-closed spawn rule: a
 *     subagent definition the daemon cannot boundary-mediate is disabled at
 *     spawn rather than admitted unenforceable.
 *   - `subagent_concurrency_breach` — leg 4's observability-only enforcement:
 *     concurrent subagents observed above the declared cap. A breach surfaces
 *     here and never fails the run.
 */
export type DriverDiagnosticKind =
  | "unmapped_wire_kind"
  | "payload_variant_pending"
  | "reorder_buffer_overflow"
  | "tool_pairing_timeout"
  | "usage_delta_floor_hit"
  | "usage_cross_check_mismatch"
  | "usage_containment_identity_unconfirmed"
  | "thread_frame_quarantined"
  | "thread_quarantine_shed"
  | "thread_pending_hold_shed"
  | "thread_registration_refused"
  | "thread_child_transcript_suppressed"
  | "callback_tool_seam_absent"
  | "callback_tool_registry_withheld"
  | "callback_tool_invocation_refused"
  | "subagent_definition_disabled"
  | "subagent_concurrency_breach";

/**
 * One operator-visible daemon diagnostic.
 *
 * The `{ provider, rawWireType, dispositionReason }` triple is the exact shape
 * Plan-005 T3.11 P0-1 pins for the default-branch record; `kind` discriminates
 * the emitting leg and selects the counter, and `details` carries the leg's
 * structured context (axis names, counts, thread identities) as flat
 * JSON-safe primitives so the log sink can serialize without walking a graph.
 *
 * `rawWireType` is `null` for records not caused by a single wire frame (a
 * buffer overflow aggregates many). Where present it is UNTRUSTED provider
 * output carried verbatim as data — never interpolated into anything that
 * executes.
 */
export interface DriverDiagnosticRecord {
  readonly provider: DriverProviderName;
  readonly kind: DriverDiagnosticKind;
  readonly rawWireType: string | null;
  readonly dispositionReason: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * The OpenTelemetry instrument name for each diagnostic kind.
 *
 * `driver.reorder_buffer.overflow` is pinned verbatim by Plan-005 T3.11 P2-1;
 * the rest follow its `driver.<band>.<condition>` shape. Keyed by the closed
 * kind union so a new kind without a counter is a compile error.
 */
export const DRIVER_DIAGNOSTIC_COUNTER_NAMES: Readonly<Record<DriverDiagnosticKind, string>> =
  Object.freeze({
    unmapped_wire_kind: "driver.normalize.unmapped_wire_kind",
    payload_variant_pending: "driver.normalize.payload_variant_pending",
    reorder_buffer_overflow: "driver.reorder_buffer.overflow",
    tool_pairing_timeout: "driver.reorder_buffer.pairing_timeout",
    usage_delta_floor_hit: "driver.usage_delta.floor_hit",
    usage_cross_check_mismatch: "driver.usage_delta.cross_check_mismatch",
    usage_containment_identity_unconfirmed: "driver.usage_delta.containment_unconfirmed",
    thread_frame_quarantined: "driver.thread_router.quarantined",
    thread_quarantine_shed: "driver.thread_router.quarantine_shed",
    thread_pending_hold_shed: "driver.thread_router.pending_hold_shed",
    thread_registration_refused: "driver.thread_router.registration_refused",
    thread_child_transcript_suppressed: "driver.thread_router.child_transcript_suppressed",
    callback_tool_seam_absent: "driver.callback_tool.seam_absent",
    callback_tool_registry_withheld: "driver.callback_tool.registry_withheld",
    callback_tool_invocation_refused: "driver.callback_tool.invocation_refused",
    subagent_definition_disabled: "driver.subagent.definition_disabled",
    subagent_concurrency_breach: "driver.subagent.concurrency_breach",
  });

// --------------------------------------------------------------------------
// Sinks — the two injected halves of the diagnostic channel.
// --------------------------------------------------------------------------

/** Lands one record on the structured daemon log stream. */
export interface DriverDiagnosticLogSink {
  record(record: DriverDiagnosticRecord): void;
}

/**
 * Increments one metrics counter. The Plan-024 measurement substrate binds an
 * OpenTelemetry-backed implementation behind this seam; until it lands, the
 * default in-memory sink keeps exact totals so the counters stay queryable.
 */
export interface DriverDiagnosticCounterSink {
  increment(counterName: string, attributes: Readonly<Record<string, string>>): void;
}

/**
 * The default log sink: one `console.warn` line per record, a stable
 * `driver-diagnostic` prefix plus the record as JSON. The daemon carries no
 * structured logger yet; its modules log through `console` (the pty and ipc
 * subsystems establish the idiom), and the single-line JSON body is what makes
 * the stream machine-parseable when a real logger replaces the sink.
 */
export class ConsoleDriverDiagnosticLogSink implements DriverDiagnosticLogSink {
  record(record: DriverDiagnosticRecord): void {
    console.warn(`driver-diagnostic ${JSON.stringify(record)}`);
  }
}

/**
 * The default counter sink: exact in-memory totals keyed by counter name plus
 * serialized attributes. This is what makes an overflow "queryable via those
 * diagnostics/metrics surfaces" (Plan-005 T3.11 P2-1) before the Plan-024
 * substrate binds OpenTelemetry behind the same interface.
 */
export class InMemoryDriverDiagnosticCounterSink implements DriverDiagnosticCounterSink {
  readonly #totalsByCounterKey = new Map<string, number>();

  increment(counterName: string, attributes: Readonly<Record<string, string>>): void {
    const counterKey = this.#composeCounterKey(counterName, attributes);
    this.#totalsByCounterKey.set(counterKey, (this.#totalsByCounterKey.get(counterKey) ?? 0) + 1);
  }

  /** The exact total for one counter name summed across attribute sets. */
  totalFor(counterName: string): number {
    let total = 0;
    for (const [counterKey, count] of this.#totalsByCounterKey) {
      if (counterKey === counterName || counterKey.startsWith(`${counterName}|`)) {
        total += count;
      }
    }
    return total;
  }

  #composeCounterKey(counterName: string, attributes: Readonly<Record<string, string>>): string {
    const attributeEntries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : 1));
    if (attributeEntries.length === 0) {
      return counterName;
    }
    const serializedAttributes = attributeEntries
      .map(([attributeName, attributeValue]) => `${attributeName}=${attributeValue}`)
      .join(",");
    return `${counterName}|${serializedAttributes}`;
  }
}

// --------------------------------------------------------------------------
// The emitter.
// --------------------------------------------------------------------------

/**
 * The single emission path onto the daemon diagnostic channel.
 *
 * Every T3.11 leg routes through one instance of this class: it freezes the
 * record, lands it on the log sink, increments the kind's counter, and retains
 * it in a bounded most-recent ring so the channel is queryable in-process.
 * Nothing here throws on a sink failure — a diagnostic surface that can take
 * down the normalizer it reports for would invert the containment the PR-A
 * `#ingest` delegate already ships, so sink errors are swallowed after a
 * best-effort fallback line.
 */
export class DriverDiagnosticsEmitter {
  static readonly DEFAULT_RECENT_RECORD_CAPACITY = 256;

  readonly #logSink: DriverDiagnosticLogSink;
  readonly #counterSink: DriverDiagnosticCounterSink;
  readonly #recentRecords: DriverDiagnosticRecord[] = [];
  readonly #recentRecordCapacity: number;
  #emittedRecordCount = 0;

  constructor(options?: {
    readonly logSink?: DriverDiagnosticLogSink;
    readonly counterSink?: DriverDiagnosticCounterSink;
    readonly recentRecordCapacity?: number;
  }) {
    this.#logSink = options?.logSink ?? new ConsoleDriverDiagnosticLogSink();
    this.#counterSink = options?.counterSink ?? new InMemoryDriverDiagnosticCounterSink();
    this.#recentRecordCapacity =
      options?.recentRecordCapacity ?? DriverDiagnosticsEmitter.DEFAULT_RECENT_RECORD_CAPACITY;
  }

  emit(record: DriverDiagnosticRecord): void {
    const frozenRecord = Object.freeze({
      ...record,
      details: Object.freeze({ ...record.details }),
    });
    this.#emittedRecordCount += 1;
    this.#recentRecords.push(frozenRecord);
    if (this.#recentRecords.length > this.#recentRecordCapacity) {
      this.#recentRecords.shift();
    }
    try {
      this.#logSink.record(frozenRecord);
    } catch {
      // A failing log sink must not take the normalize boundary down with it.
    }
    try {
      this.#counterSink.increment(DRIVER_DIAGNOSTIC_COUNTER_NAMES[frozenRecord.kind], {
        provider: frozenRecord.provider,
      });
    } catch {
      // Same containment for the metrics half.
    }
  }

  /** Most-recent records, oldest first, bounded by the retention capacity. */
  recentRecords(): readonly DriverDiagnosticRecord[] {
    return [...this.#recentRecords];
  }

  /** Total records emitted over the emitter's lifetime (sheds not subtracted). */
  emittedRecordCount(): number {
    return this.#emittedRecordCount;
  }

  /** Records currently retained for one kind, oldest first. */
  recentRecordsOfKind(kind: DriverDiagnosticKind): readonly DriverDiagnosticRecord[] {
    return this.#recentRecords.filter((record) => record.kind === kind);
  }
}

// --------------------------------------------------------------------------
// The bounded reorder buffer (Plan-005 T3.11 P2-1).
// --------------------------------------------------------------------------

/**
 * One buffered normalized event awaiting its pair.
 *
 * `toolCallId` is the canonical pairing key — the provider `tool_use_id`
 * normalized into `payload.toolCallId` per Spec-006 §Required Behavior —
 * carried verbatim. `pairingRole` states which half of a tool pair the event
 * is; an `unpaired` event never waits and flows straight through in arrival
 * order.
 */
export interface ReorderBufferedEvent<TEvent> {
  readonly toolCallId: string | null;
  readonly pairingRole: "initiation" | "completion" | "unpaired";
  readonly event: TEvent;
}

/**
 * The bounded reorder buffer the normalize boundary carries (Plan-005 T3.11
 * P2-1). Per-run arrival order is preserved; the single reordering it performs
 * is holding a tool COMPLETION that arrived before its INITIATION until the
 * initiation lands, so tool events pair by `toolCallId` for downstream
 * consumers. No global causal-order guarantee across aggregates is attempted.
 *
 * Two never-silent conditions, each a `DriverDiagnosticRecord` plus a counter
 * (a silent flush would degrade to invisible reordering, so the paired
 * diagnostic + metric is load-bearing, not advisory):
 *
 *   - OVERFLOW (`maxBufferedEvents` exceeded): every held event flushes in
 *     arrival order and `driver.reorder_buffer.overflow` increments.
 *   - PAIRING TIMEOUT (an unpaired `toolCallId` held past `pairingTimeoutMs`):
 *     the expired event flushes in arrival order and
 *     `driver.reorder_buffer.pairing_timeout` increments.
 *
 * The clock is caller-supplied (`nowMs` on every admitting call) so the buffer
 * is deterministic under test and owns no timer.
 */
export class NormalizedEventReorderBuffer<TEvent> {
  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxBufferedEvents: number;
  readonly #pairingTimeoutMs: number;
  readonly #heldCompletions: {
    readonly buffered: ReorderBufferedEvent<TEvent>;
    readonly heldAtMs: number;
  }[] = [];
  readonly #seenInitiationToolCallIds = new Set<string>();

  constructor(options: {
    readonly provider: DriverProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxBufferedEvents: number;
    readonly pairingTimeoutMs: number;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#maxBufferedEvents = options.maxBufferedEvents;
    this.#pairingTimeoutMs = options.pairingTimeoutMs;
  }

  /**
   * Admit one event; returns the events released by this admission, in order.
   *
   * An initiation or unpaired event releases immediately (plus any completion
   * that was waiting for that initiation). A completion whose initiation has
   * not been seen is held. Overflow flushes everything in arrival order with
   * the overflow diagnostic.
   */
  admit(buffered: ReorderBufferedEvent<TEvent>, nowMs: number): readonly TEvent[] {
    const released: TEvent[] = [...this.#releaseExpired(nowMs)];

    if (buffered.pairingRole === "completion" && buffered.toolCallId !== null) {
      if (!this.#seenInitiationToolCallIds.has(buffered.toolCallId)) {
        this.#heldCompletions.push({ buffered, heldAtMs: nowMs });
        if (this.#heldCompletions.length > this.#maxBufferedEvents) {
          released.push(...this.#flushAllOnOverflow());
        }
        return released;
      }
      released.push(buffered.event);
      return released;
    }

    if (buffered.pairingRole === "initiation" && buffered.toolCallId !== null) {
      this.#seenInitiationToolCallIds.add(buffered.toolCallId);
      released.push(buffered.event);
      released.push(...this.#releaseHeldCompletionsFor(buffered.toolCallId));
      return released;
    }

    released.push(buffered.event);
    return released;
  }

  /** Release held events whose pairing timeout has expired, with diagnostics. */
  flushExpired(nowMs: number): readonly TEvent[] {
    return this.#releaseExpired(nowMs);
  }

  /** The number of events currently held awaiting a pair. */
  heldEventCount(): number {
    return this.#heldCompletions.length;
  }

  #releaseHeldCompletionsFor(toolCallId: string): TEvent[] {
    const released: TEvent[] = [];
    for (let index = this.#heldCompletions.length - 1; index >= 0; index -= 1) {
      const held = this.#heldCompletions[index];
      if (held !== undefined && held.buffered.toolCallId === toolCallId) {
        this.#heldCompletions.splice(index, 1);
        released.unshift(held.buffered.event);
      }
    }
    return released;
  }

  #releaseExpired(nowMs: number): TEvent[] {
    const released: TEvent[] = [];
    for (let index = 0; index < this.#heldCompletions.length; ) {
      const held = this.#heldCompletions[index];
      if (held !== undefined && nowMs - held.heldAtMs >= this.#pairingTimeoutMs) {
        this.#heldCompletions.splice(index, 1);
        released.push(held.buffered.event);
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "tool_pairing_timeout",
          rawWireType: null,
          dispositionReason:
            "unpaired toolCallId held past pairingTimeoutMs; flushed in arrival order per Plan-005 T3.11 P2-1",
          details: {
            toolCallId: held.buffered.toolCallId,
            heldForMs: nowMs - held.heldAtMs,
            pairingTimeoutMs: this.#pairingTimeoutMs,
          },
        });
      } else {
        index += 1;
      }
    }
    return released;
  }

  #flushAllOnOverflow(): TEvent[] {
    const flushed = this.#heldCompletions.map((held) => held.buffered.event);
    const flushedCount = this.#heldCompletions.length;
    this.#heldCompletions.length = 0;
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "reorder_buffer_overflow",
      rawWireType: null,
      dispositionReason:
        "reorder buffer exceeded maxBufferedEvents; flushed in arrival order per Spec-006 §Required Behavior overflow rule",
      details: { flushedEventCount: flushedCount, maxBufferedEvents: this.#maxBufferedEvents },
    });
    return flushed;
  }
}

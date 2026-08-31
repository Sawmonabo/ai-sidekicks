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
 *   - `reorder_initiation_ledger_evicted` — P2-1's third bound: the seen-
 *     initiation ledger is per-provider-session state with no completion
 *     guarantee, so it is capped and evicted oldest-first. An eviction changes
 *     how a later completion for that call routes, so it is never silent.
 *   - `usage_delta_floor_hit` — the usage-delta rule: an observed decrease on
 *     a declared-cumulative axis is a falsified declaration, floored at zero
 *     and reported, never emitted as negative spend.
 *   - `usage_axis_reading_rejected` — a cumulative reading carrying a key
 *     outside the closed axis list or a non-finite value. Rejected BEFORE it
 *     reaches a base register: a NaN admitted into a register poisons every
 *     later delta on that axis (`NaN < 0` is false, so the floor arm never
 *     fires) and the poison is unrecoverable without a re-establishment.
 *   - `usage_resume_base_unavailable` — a resume or rewind whose prior-emitted
 *     cumulative sum could not be OBTAINED: no reader is bound, or the reader
 *     threw. Distinct from a reader that answers with nothing — a session that
 *     legitimately emitted no spend bases at zero correctly and records
 *     nothing. On the faulty arm the base starts at zero and the first reading
 *     re-meters the whole pre-resume total, so the overstatement is recorded
 *     rather than left to surface on a receipt.
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
 *   - `thread_duplicate_child_announcement` — a second announcement for a child
 *     whose usage base is already established. Distinct from a refusal: the
 *     router accepted the registration (re-registering an identity it already
 *     holds is a no-op), and what the driver declined is the RE-BASING and the
 *     duplicate `subagent.started`. Re-basing mid-stream would reset the
 *     child's register to zero and re-meter its whole spend on the next
 *     reading, so the announcement is recorded and the base retained.
 *   - `thread_child_transcript_suppressed` — first suppression of a registered
 *     child thread's transcript projection (deduplicated per thread so child
 *     content deltas do not flood the channel).
 *
 * Three are owned by the T3.12 capability-refresh cadence and the T3.24
 * detection read that runs inside it. They live here for the same reason as
 * everything else on this union: a scheduler-local callback would be a second
 * diagnostic surface, and a failure reported there is unmetered.
 *
 *   - `capability_refresh_failed` — a driver's capability re-declaration threw
 *     or exceeded its liveness deadline during a scheduled refresh.
 *   - `auth_probe_failed` — a driver's auth probe threw or exceeded its
 *     liveness deadline, so the node's auth state for that driver is unchanged
 *     rather than presumed authenticated.
 *   - `capability_flag_withdrawn` — a detection read that SUCCEEDED and
 *     withdrew a flag the driver's matrix declares: the probe channel answered,
 *     and this build turned out not to carry the surface behind that flag. The
 *     two kinds above cover only reads that FAILED, so without this one the
 *     node-visible outcome — a capability quietly lost between one refresh and
 *     the next — is the single capability-band condition that reaches an
 *     operator through no counter at all.
 *
 * The remaining eight are owned by named Plan-005 T3.15 and T3.18 legs (callback-tool
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
 *     tool, carrying arguments the registered input schema rejects, or raised
 *     against a registry installation a later spawn has already superseded.
 *     Answered `failed` without ever reaching the approval pipeline.
 *   - `callback_tool_registry_superseded` — leg 3's spawn-scoping rule: a
 *     second spawn installed a registry for a session that still had one
 *     installed. Not itself a fault — a resume or relaunch reaches this
 *     legitimately — but it is the moment after which the superseded spawn's
 *     dispatcher and teardown stop acting on the session, so an operator
 *     reading either of those refusals needs this record to explain them.
 *   - `callback_tool_registry_release_ignored` — a superseded spawn's teardown
 *     ran after its registry had been replaced. The replacement is left
 *     installed and the release is recorded rather than silently honoured,
 *     because honouring it would tear down the LIVE spawn's registry.
 *   - `subagent_definition_disabled` — leg 4's fail-closed spawn rule: a
 *     subagent definition the daemon cannot boundary-mediate is disabled at
 *     spawn rather than admitted unenforceable.
 *   - `subagent_concurrency_breach` — leg 4's observability-only enforcement:
 *     concurrent subagents observed above the declared cap. A breach surfaces
 *     here and never fails the run.
 *   - `text_neutralization_trip_report_failed` — T3.18: the tripwire ruled a
 *     provider-bound text frame swallowed, and the consumer the run terminal is
 *     reported to threw. The trip itself still stands and the binding is still
 *     disposed; what this records is that the operator-visible terminal may not
 *     have landed, which is the one part of a trip that a swallowed exception
 *     could make invisible.
 */
export type DriverDiagnosticKind =
  | "unmapped_wire_kind"
  | "payload_variant_pending"
  | "reorder_buffer_overflow"
  | "tool_pairing_timeout"
  | "reorder_initiation_ledger_evicted"
  | "usage_delta_floor_hit"
  | "usage_axis_reading_rejected"
  | "usage_resume_base_unavailable"
  | "usage_cross_check_mismatch"
  | "usage_containment_identity_unconfirmed"
  | "thread_frame_quarantined"
  | "thread_quarantine_shed"
  | "thread_pending_hold_shed"
  | "thread_registration_refused"
  | "thread_duplicate_child_announcement"
  | "thread_child_transcript_suppressed"
  | "capability_refresh_failed"
  | "auth_probe_failed"
  | "capability_flag_withdrawn"
  | "callback_tool_seam_absent"
  | "callback_tool_registry_withheld"
  | "callback_tool_invocation_refused"
  | "callback_tool_registry_superseded"
  | "callback_tool_registry_release_ignored"
  | "subagent_definition_disabled"
  | "subagent_concurrency_breach"
  | "text_neutralization_trip_report_failed";

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
    reorder_initiation_ledger_evicted: "driver.reorder_buffer.initiation_ledger_evicted",
    usage_delta_floor_hit: "driver.usage_delta.floor_hit",
    usage_axis_reading_rejected: "driver.usage_delta.axis_reading_rejected",
    usage_resume_base_unavailable: "driver.usage_delta.resume_base_unavailable",
    usage_cross_check_mismatch: "driver.usage_delta.cross_check_mismatch",
    usage_containment_identity_unconfirmed: "driver.usage_delta.containment_unconfirmed",
    thread_frame_quarantined: "driver.thread_router.quarantined",
    thread_quarantine_shed: "driver.thread_router.quarantine_shed",
    thread_pending_hold_shed: "driver.thread_router.pending_hold_shed",
    thread_registration_refused: "driver.thread_router.registration_refused",
    thread_duplicate_child_announcement: "driver.thread_router.duplicate_child_announcement",
    thread_child_transcript_suppressed: "driver.thread_router.child_transcript_suppressed",
    capability_refresh_failed: "driver.capability_refresh.declaration_failed",
    auth_probe_failed: "driver.capability_refresh.auth_probe_failed",
    capability_flag_withdrawn: "driver.capability_refresh.flag_withdrawn",
    callback_tool_seam_absent: "driver.callback_tool.seam_absent",
    callback_tool_registry_withheld: "driver.callback_tool.registry_withheld",
    callback_tool_invocation_refused: "driver.callback_tool.invocation_refused",
    callback_tool_registry_superseded: "driver.callback_tool.registry_superseded",
    callback_tool_registry_release_ignored: "driver.callback_tool.registry_release_ignored",
    subagent_definition_disabled: "driver.subagent.definition_disabled",
    subagent_concurrency_breach: "driver.subagent.concurrency_breach",
    text_neutralization_trip_report_failed: "driver.text_neutralization.trip_report_failed",
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
 * The bounded reorder buffer for a normalize boundary that pairs tool events
 * (Plan-005 T3.11 P2-1).
 *
 * Constructed by the EMISSION PIPELINE, not by a driver lifecycle band: pairing
 * operates on normalized events, and the lifecycle bands hand raw frames to
 * that pipeline rather than producing events of their own. Stated so the class
 * is not read as already carried by a driver.
 *
 * Per-run arrival order is preserved; the single reordering it performs
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
 * A third bound covers the SEEN-INITIATION LEDGER, which is not a buffer of
 * events but of identities. It grows once per tool call for the life of a
 * provider session, and no wire guarantees a completion ever arrives, so an
 * unbounded ledger is a leak on the longest-lived object in the driver. It is
 * capped at `maxSeenInitiationIds`, drained on pairing (a paired call needs no
 * further ledger entry), and evicted oldest-first with the never-silent
 * `driver.reorder_buffer.initiation_ledger_evicted` diagnostic — eviction
 * changes how a later completion for that call routes, so it is reported.
 *
 * The clock is caller-supplied (`nowMs` on every admitting call) so the buffer
 * is deterministic under test and owns no timer.
 */
export class NormalizedEventReorderBuffer<TEvent> {
  /** Ledger cap when the caller declares none. */
  static readonly DEFAULT_MAX_SEEN_INITIATION_IDS = 1024;

  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxBufferedEvents: number;
  readonly #pairingTimeoutMs: number;
  readonly #maxSeenInitiationIds: number;
  readonly #heldCompletions: {
    readonly buffered: ReorderBufferedEvent<TEvent>;
    readonly heldAtMs: number;
  }[] = [];
  /** Insertion-ordered, so the eviction sweep takes the oldest entry first. */
  readonly #seenInitiationToolCallIds = new Set<string>();

  constructor(options: {
    readonly provider: DriverProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxBufferedEvents: number;
    readonly pairingTimeoutMs: number;
    readonly maxSeenInitiationIds?: number;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#maxBufferedEvents = options.maxBufferedEvents;
    this.#pairingTimeoutMs = options.pairingTimeoutMs;
    this.#maxSeenInitiationIds =
      options.maxSeenInitiationIds ?? NormalizedEventReorderBuffer.DEFAULT_MAX_SEEN_INITIATION_IDS;
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
      // The pair is closed: the ledger entry has no further reader, so drop it
      // rather than retaining one identity per tool call for the session.
      this.#seenInitiationToolCallIds.delete(buffered.toolCallId);
      released.push(buffered.event);
      return released;
    }

    if (buffered.pairingRole === "initiation" && buffered.toolCallId !== null) {
      this.#admitSeenInitiation(buffered.toolCallId);
      released.push(buffered.event);
      const pairedCompletions = this.#releaseHeldCompletionsFor(buffered.toolCallId);
      if (pairedCompletions.length > 0) {
        this.#seenInitiationToolCallIds.delete(buffered.toolCallId);
      }
      released.push(...pairedCompletions);
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

  /** Identities currently retained in the seen-initiation ledger. */
  seenInitiationCount(): number {
    return this.#seenInitiationToolCallIds.size;
  }

  #admitSeenInitiation(toolCallId: string): void {
    this.#seenInitiationToolCallIds.add(toolCallId);
    while (this.#seenInitiationToolCallIds.size > this.#maxSeenInitiationIds) {
      const oldestEntry = this.#seenInitiationToolCallIds.values().next();
      if (oldestEntry.done === true) {
        return;
      }
      this.#seenInitiationToolCallIds.delete(oldestEntry.value);
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "reorder_initiation_ledger_evicted",
        rawWireType: null,
        dispositionReason:
          "seen-initiation ledger exceeded its declared cap; oldest identity evicted, so a later completion for it holds instead of pairing",
        details: {
          toolCallId: oldestEntry.value,
          maxSeenInitiationIds: this.#maxSeenInitiationIds,
        },
      });
    }
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
            "unpaired toolCallId held past the reorder buffer's pairing timeout; flushed in arrival order",
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
        "reorder buffer exceeded its maximum buffered-event cap; flushed in arrival order",
      details: { flushedEventCount: flushedCount, maxBufferedEvents: this.#maxBufferedEvents },
    });
    return flushed;
  }
}

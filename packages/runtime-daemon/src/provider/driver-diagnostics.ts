// The daemon diagnostic channel both event normalizers route to: the typed
// `DriverDiagnosticRecord`, the emitter that lands each record on the daemon log and a counter,
// and the bounded reorder buffer. These are diagnostics for the person, never `session_events`
// envelopes; a frame that reaches this channel is never silently dropped.

import type { ProviderName } from "@ai-sidekicks/contracts";

/**
 * The closed set of diagnostic kinds. The counter-name map is keyed by it, so a kind added
 * without a counter is a compile error rather than an unmetered record.
 */
export type DriverDiagnosticKind =
  // A wire kind outside the pinned set, or one with no defined `SessionEventType`.
  | "unmapped_wire_kind"
  // A known kind whose `SessionEventType` has no registered payload variant, so no envelope can
  // be built.
  | "payload_variant_pending"
  // The reorder buffer's never-silent conditions.
  | "reorder_buffer_overflow"
  | "tool_pairing_timeout"
  // The capped seen-initiation set evicted its oldest entry, which changes how a later
  // completion for that call routes.
  | "reorder_seen_initiation_evicted"
  // A decrease on a cumulative axis is floored at zero, never emitted as negative spend.
  | "usage_delta_floor_hit"
  // An unknown axis key or non-finite reading is rejected before it reaches a base register: a
  // NaN there poisons every later delta, since `NaN < 0` is false and the floor never fires.
  | "usage_axis_reading_rejected"
  // The prior-emitted sum for a resume or rewind was unobtainable, so the base starts at zero and
  // the first reading re-meters the pre-resume total. A reader answering with nothing is not this.
  | "usage_resume_base_unavailable"
  // A wire-declared per-turn figure disagrees with the derived interval; recorded, never
  // substituted.
  | "usage_cross_check_mismatch"
  // A token breakdown satisfying no containment identity is emitted unsubtracted, so the
  // overstatement surfaces instead of a silent understatement.
  | "usage_containment_identity_unconfirmed"
  // The router's fail-closed refusal of absent or unrecognized identities, and the bounded
  // quarantine buffer's oldest-first sheds.
  | "thread_frame_quarantined"
  | "thread_quarantine_shed"
  // A present but unregistered identity whose registration missed the declared timeout.
  | "thread_pending_hold_shed"
  // A child announcement with no recognized parent linkage; recognition follows declared lineage,
  // never arrival order.
  | "thread_registration_refused"
  // A second announcement for a child whose usage base exists. The driver declines to re-base
  // (that would re-meter the child's whole spend) and to emit a second `subagent.started`.
  | "thread_duplicate_child_announcement"
  // The first suppression per thread of a child's transcript projection, so deltas do not flood.
  | "thread_child_transcript_suppressed"
  // A capability re-declaration threw or missed its liveness deadline.
  | "capability_refresh_failed"
  // A successful detection read withdrew a flag the matrix declares because this build lacks the
  // surface; the failed-read kinds above do not cover a capability quietly lost between refreshes.
  | "capability_flag_withdrawn"
  // An invocation or provider ask reached the host with no evaluation seam registered; answered
  // refused, never completed without Cedar and never left unanswered.
  | "callback_tool_seam_absent"
  // The registry was withheld at spawn because the daemon could not guarantee every invocation
  // would be adjudicated.
  | "callback_tool_registry_withheld"
  // An unregistered tool, arguments the schema rejects, or a superseded registry; answered
  // `failed` without reaching the approval pipeline.
  | "callback_tool_invocation_refused"
  // A resume or relaunch installed a second registry for the session; explains the superseded
  // spawn's refusals.
  | "callback_tool_registry_superseded"
  // A superseded spawn's teardown ran after replacement; honoring it would tear down the live
  // registry.
  | "callback_tool_registry_release_ignored"
  // The activity sink threw while recording an invocation that was already answered; the answer
  // stands and only the activity row is missing.
  | "callback_tool_activity_record_failed"
  // A subagent definition the daemon cannot boundary-mediate is disabled at spawn.
  | "subagent_definition_disabled"
  // Concurrent subagents above the declared cap; observability only, never fails the run.
  | "subagent_concurrency_breach"
  // The tripwire swallowed a provider-bound text frame and the run-terminal consumer threw; the
  // trip and the disposal stand, but the terminal the person sees may not have landed.
  | "text_neutralization_trip_report_failed"
  // The wait for the typed compaction frame ended without it (per-driver bound elapsed, or the
  // binding stopped being live); records which fired. Never emitted when compaction applied.
  | "compaction_wait_terminal"
  // Entries beyond the per-group cap were dropped and `complete` is false; carries both counts.
  | "provider_command_entries_truncated"
  // An entry broke the contract's bounds; it is dropped and its siblings are unaffected.
  | "provider_command_entry_rejected"
  // A declared output-speed state broke the bounds, so the binding reads as unobserved until the
  // provider declares another. Details carry the field and lengths, never untrusted values.
  | "output_speed_state_rejected"
  // A choice set over the cardinality cap or with no readable admissible option. The ask still
  // reaches the user as free text; only the choice set is lost.
  | "interactive_request_option_set_dropped"
  // A receiver-generated task handle could not be stored on its receipt row (over a column bound,
  // ill-formed Unicode, absent row, or a different handle; `dispositionReason` names which). The
  // receipt stays on the `manual_reconcile_only` halt, and the handle is never logged.
  | "mcp_task_handle_write_refused"
  // The database refused a storable handle: a local fault, kept apart from the remote-caused
  // refusal. `dispositionReason` carries the SQLite result code; the message interpolates SQL.
  | "mcp_task_handle_write_failed";

/**
 * One daemon diagnostic the person sees; `details` is flat JSON-safe primitives. `rawWireType` is
 * null when no single frame caused it, else untrusted provider output: never interpolate it into
 * anything that executes.
 */
export interface DriverDiagnosticRecord {
  readonly provider: ProviderName;
  readonly kind: DriverDiagnosticKind;
  readonly rawWireType: string | null;
  readonly dispositionReason: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/** The OpenTelemetry instrument name per kind, shaped `driver.<band>.<condition>`. */
export const DRIVER_DIAGNOSTIC_COUNTER_NAMES: Readonly<Record<DriverDiagnosticKind, string>> =
  Object.freeze({
    unmapped_wire_kind: "driver.normalize.unmapped_wire_kind",
    payload_variant_pending: "driver.normalize.payload_variant_pending",
    reorder_buffer_overflow: "driver.reorder_buffer.overflow",
    tool_pairing_timeout: "driver.reorder_buffer.pairing_timeout",
    reorder_seen_initiation_evicted: "driver.reorder_buffer.seen_initiation_evicted",
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
    capability_flag_withdrawn: "driver.capability_refresh.flag_withdrawn",
    callback_tool_seam_absent: "driver.callback_tool.seam_absent",
    callback_tool_registry_withheld: "driver.callback_tool.registry_withheld",
    callback_tool_invocation_refused: "driver.callback_tool.invocation_refused",
    callback_tool_registry_superseded: "driver.callback_tool.registry_superseded",
    callback_tool_registry_release_ignored: "driver.callback_tool.registry_release_ignored",
    callback_tool_activity_record_failed: "driver.callback_tool.activity_record_failed",
    subagent_definition_disabled: "driver.subagent.definition_disabled",
    subagent_concurrency_breach: "driver.subagent.concurrency_breach",
    text_neutralization_trip_report_failed: "driver.text_neutralization.trip_report_failed",
    compaction_wait_terminal: "driver.compaction.wait_terminal",
    provider_command_entries_truncated: "driver.provider_commands.entries_truncated",
    provider_command_entry_rejected: "driver.provider_commands.entry_rejected",
    output_speed_state_rejected: "driver.output_speed.state_rejected",
    interactive_request_option_set_dropped: "driver.interactive_request.option_set_dropped",
    mcp_task_handle_write_refused: "driver.mcp_task_handle.write_refused",
    mcp_task_handle_write_failed: "driver.mcp_task_handle.write_failed",
  });

/** Lands one record on the structured daemon log stream. */
export interface DriverDiagnosticLogSink {
  record(record: DriverDiagnosticRecord): void;
}

/** Increments one metrics counter; the default in-memory sink keeps exact totals. */
export interface DriverDiagnosticCounterSink {
  increment(counterName: string, attributes: Readonly<Record<string, string>>): void;
}

/** The default log sink: one `console.warn` line per record as `driver-diagnostic <json>`. */
class ConsoleDriverDiagnosticLogSink implements DriverDiagnosticLogSink {
  record(record: DriverDiagnosticRecord): void {
    console.warn(`driver-diagnostic ${JSON.stringify(record)}`);
  }
}

/** The default counter sink: exact totals keyed by counter name plus serialized attributes. */
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

/**
 * The single emission path onto the diagnostic channel: freezes the record, logs it, increments
 * its counter and keeps it in a bounded ring. A sink failure never propagates.
 */
export class DriverDiagnosticsEmitter {
  /** Records retained for in-process queries when the caller declares no capacity. */
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

  /** Emits one record; a throwing sink is contained and never reaches the caller. */
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
      // A failing log sink must not take down the normalize boundary.
    }
    try {
      this.#counterSink.increment(DRIVER_DIAGNOSTIC_COUNTER_NAMES[frozenRecord.kind], {
        provider: frozenRecord.provider,
      });
    } catch {
      // Same containment for the counter sink.
    }
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

/**
 * One buffered normalized event awaiting its pair. `toolCallId` is the provider `tool_use_id`
 * carried verbatim; an `unpaired` event never waits.
 */
export interface ReorderBufferedEvent<TEvent> {
  readonly toolCallId: string | null;
  readonly pairingRole: "initiation" | "completion" | "unpaired";
  readonly event: TEvent;
}

/**
 * The bounded reorder buffer for a boundary that pairs tool events by `toolCallId`: the only
 * reordering is holding a completion that arrives before its initiation. Overflow and pairing
 * timeout flush in arrival order, each with a diagnostic; the clock is caller-supplied (`nowMs`).
 */
export class NormalizedEventReorderBuffer<TEvent> {
  /** Seen-initiation cap when the caller declares none. */
  static readonly DEFAULT_MAX_SEEN_INITIATION_IDS = 1024;

  readonly #provider: ProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxBufferedEvents: number;
  readonly #pairingTimeoutMs: number;
  readonly #maxSeenInitiationIds: number;
  readonly #heldCompletions: {
    readonly buffered: ReorderBufferedEvent<TEvent>;
    readonly heldAtMs: number;
  }[] = [];
  // Capped and drained on pairing: one identity is added per tool call and no completion is
  // guaranteed, so unbounded it would leak. Insertion-ordered, so eviction takes the oldest.
  readonly #seenInitiationToolCallIds = new Set<string>();

  constructor(options: {
    readonly provider: ProviderName;
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

  /** Admits one event; returns the events it releases, in order. */
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

  /** Releases held events whose pairing timeout has expired, emitting a diagnostic for each. */
  flushExpired(nowMs: number): readonly TEvent[] {
    return this.#releaseExpired(nowMs);
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
        kind: "reorder_seen_initiation_evicted",
        rawWireType: null,
        dispositionReason:
          "seen-initiation set exceeded its declared cap; oldest identity evicted, so a later completion for it holds instead of pairing",
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

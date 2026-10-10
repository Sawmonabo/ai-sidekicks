// The daemon diagnostic channel the provider drivers and the run engine route to: the typed
// `DriverDiagnosticRecord` and the emitter that lands each record on the daemon log and a counter.
// These are diagnostics for the person, never `session_events` envelopes; a frame that reaches
// this channel is never silently dropped.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

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
  | "subagent_definition_field_withheld"
  // A rewind or resume superseded a run's turn and the run-terminal consumer threw; the
  // supersession stands, but the failure the person sees may not have landed.
  | "superseded_run_report_failed"
  // The wait for the typed compaction frame ended without it, because the binding stopped being
  // live. Never emitted when compaction applied.
  | "compaction_wait_terminal"
  // An entry broke the contract's bounds; it is dropped and its siblings are unaffected.
  | "provider_command_entry_rejected"
  // A declared output-speed state broke the bounds, so the binding reads as unobserved until the
  // provider declares another. Details carry the field and lengths, never untrusted values.
  | "output_speed_state_rejected"
  // The provider refused the output-speed level the driver applied, so the process runs on the
  // level it held; the run's declared state reports which.
  | "output_speed_apply_refused"
  // A choice set with an unreadable option or no readable admissible one. The ask still
  // reaches the user as free text; only the choice set is lost.
  | "interactive_request_option_set_dropped"
  // A receiver-generated task handle could not be stored on its receipt row (over a column bound,
  // ill-formed Unicode, absent row, or a different handle; `dispositionReason` names which). The
  // call stays halted after a restart, never run again, and the handle is never logged.
  | "mcp_task_handle_write_refused"
  // The database refused a storable handle: a local fault, kept apart from the remote-caused
  // refusal. `dispositionReason` carries the SQLite result code; the message interpolates SQL.
  | "mcp_task_handle_write_failed"
  // A provider delivery the run engine absorbed instead of appending: a lifecycle event or ask from
  // the execution before an undo's cut, or a lifecycle event for a run that had already ended.
  | "late_event_absorbed"
  // A binding's capped set of operation associations evicted its oldest entry, so a late delivery
  // of that operation is attributed to the execution before the last cut, never to the current one.
  | "epoch_association_evicted"
  // A provider process or service that ended on its own was started again; names the account and
  // each conversation it resumed, and counts per account, so one that keeps dying shows.
  | "provider_restarted"
  // The crash that filled the crash window ended the automatic restarts; carries how it exited.
  | "provider_crash_loop"
  // Reporting a process's exit, a restart or a build move, or pointing a binding back after a
  // failed rewind, failed with no caller left to tell.
  | "process_report_failed"
  // A delivery the run engine or a registered port refused or failed to take.
  | "delivery_dispatch_failed"
  // A control frame from the provider with no request id or subtype, so nothing could take it.
  | "control_frame_malformed"
  // Writing the daemon's answer to a provider's control request failed; the process is ended.
  | "control_answer_failed"
  // A provider output line passed the daemon's frame size ceiling; the process is ended.
  | "provider_frame_oversized"
  // A short control-only process's read (a command's choices, a model's reply reserve) failed; what
  // needed it says why.
  | "control_only_read_failed"
  // Codex's catalog dump, or one row of it, could not be run or read; those picker rows carry no
  // window.
  | "model_window_read_failed"
  // A message's final text did not begin with the text already streamed as its pieces, which stand.
  | "streamed_text_diverged"
  // The provider cut a response short after some of its blocks were streamed: what still waited is
  // dropped, and the pieces already stored stay.
  | "streamed_blocks_abandoned";

/**
 * One daemon diagnostic the person sees; `details` is flat JSON-safe primitives. `rawWireType` is
 * null when no single frame caused it, else untrusted provider output: never interpolate it into
 * anything that executes. `providerAccountId` names the account a record is about, which its
 * counter is also counted by.
 */
export interface DriverDiagnosticRecord {
  readonly provider: ProviderName;
  readonly providerAccountId?: string | undefined;
  readonly kind: DriverDiagnosticKind;
  readonly rawWireType: string | null;
  readonly dispositionReason: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * The OpenTelemetry instrument name per kind, shaped `driver.<band>.<condition>`, or
 * `run.<band>.<condition>` for a kind the run engine records.
 */
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
    capability_refresh_failed: "driver.capability_refresh.declaration_failed",
    capability_flag_withdrawn: "driver.capability_refresh.flag_withdrawn",
    callback_tool_seam_absent: "driver.callback_tool.seam_absent",
    callback_tool_registry_withheld: "driver.callback_tool.registry_withheld",
    callback_tool_invocation_refused: "driver.callback_tool.invocation_refused",
    callback_tool_registry_superseded: "driver.callback_tool.registry_superseded",
    callback_tool_registry_release_ignored: "driver.callback_tool.registry_release_ignored",
    callback_tool_activity_record_failed: "driver.callback_tool.activity_record_failed",
    subagent_definition_field_withheld: "driver.subagent.definition_field_withheld",
    superseded_run_report_failed: "driver.session.superseded_run_report_failed",
    compaction_wait_terminal: "driver.compaction.wait_terminal",
    provider_command_entry_rejected: "driver.provider_commands.entry_rejected",
    output_speed_state_rejected: "driver.output_speed.state_rejected",
    output_speed_apply_refused: "driver.output_speed.apply_refused",
    interactive_request_option_set_dropped: "driver.interactive_request.option_set_dropped",
    mcp_task_handle_write_refused: "driver.mcp_task_handle.write_refused",
    mcp_task_handle_write_failed: "driver.mcp_task_handle.write_failed",
    late_event_absorbed: "run.late_event.absorbed",
    epoch_association_evicted: "run.epoch.association_evicted",
    provider_restarted: "driver.process.restarted",
    provider_crash_loop: "driver.process.crash_loop",
    process_report_failed: "driver.process.report_failed",
    delivery_dispatch_failed: "driver.delivery.dispatch_failed",
    control_frame_malformed: "driver.control.frame_malformed",
    control_answer_failed: "driver.control.answer_failed",
    provider_frame_oversized: "driver.process.frame_oversized",
    control_only_read_failed: "driver.control_only.read_failed",
    model_window_read_failed: "driver.model_window.read_failed",
    streamed_text_diverged: "driver.streamed_text.diverged",
    streamed_blocks_abandoned: "driver.streamed_text.blocks_abandoned",
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
  static readonly #DEFAULT_RECENT_RECORD_CAPACITY = 256;

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
      options?.recentRecordCapacity ?? DriverDiagnosticsEmitter.#DEFAULT_RECENT_RECORD_CAPACITY;
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
        ...(frozenRecord.providerAccountId === undefined
          ? {}
          : { providerAccountId: frozenRecord.providerAccountId }),
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

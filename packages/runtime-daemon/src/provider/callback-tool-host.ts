// Callback-tool host (Plan-005 Phase 3, T3.15 leg 3).
//
// The daemon-side dispatcher behind `CreateSessionParams.onCallbackToolCall`.
// A driver translates its provider's wire request into a
// `CallbackToolInvocation`, hands it here, and answers the provider with the
// `CallbackToolResult` this host returns. That is the whole contract, and it
// carries one guarantee in each direction: no invocation is ever left
// unanswered, and no invocation is ever answered `completed` without having
// been adjudicated.
//
// ---------------------------------------------------------------------------
// Where the adjudication happens, and why it is a seam
// ---------------------------------------------------------------------------
//
// Every invocation routes through Plan-012's approval pipeline via the
// Plan-012-REGISTERED evaluation seam (CP-005-7). Plan-005 authors no Plan-012
// symbol: the seam below is a port this package declares and Plan-012's
// composed `check()` satisfies, so a callback tool is Cedar-governed exactly as
// a provider-native tool is and this file contains no policy of its own.
//
// EVALUATE-FIRST, never a bare create (Plan-012 T2.10 / D-012-18). The seam is
// asked to EVALUATE, and only an ask-policy outcome mints an approval request:
// a policy allow or a valid remembered rule completes with no request minted at
// all, and a deny refuses outright. That ordering is why this port has one
// `evaluate` method rather than a `create`-then-await pair — a host that minted
// first would put an approval request in front of a participant for every
// invocation their own policy already settled.
//
// ---------------------------------------------------------------------------
// Fail-closed availability
// ---------------------------------------------------------------------------
//
// The pipeline this host depends on is a SIBLING PLAN's, so the daemon can be
// running with no seam registered. That is not a machine gate on Plan-012 and
// never blocks a session; it degrades in one direction only:
//
//   AT SPAWN — with no registered seam, the callback-tool registry is WITHHELD
//   from the provider entirely (the leg-4 disabled-at-spawn pattern). A tool
//   the daemon cannot adjudicate is not offered, so the model never learns it
//   exists and never spends a turn calling something that can only be refused.
//
//   AT RUNTIME — a stray invocation that reaches a seamless host anyway (a
//   provider that registered tools on an earlier connection, a build that
//   offers a tool the daemon did not register) is answered `denied` plus a
//   `DriverDiagnosticRecord`. Never `completed` without Cedar, and never
//   unanswered.
//
// Both refusals are recorded rather than silent: an operator whose callback
// tools stopped appearing must be able to find out why from the diagnostic
// channel rather than from the absence of a behaviour.
//
// ---------------------------------------------------------------------------
// What is checked before the pipeline is consulted
// ---------------------------------------------------------------------------
//
// `CallbackToolInvocationSchema` has already bounded the strings and the ids by
// the time a value arrives here; what it cannot check is anything requiring the
// SESSION'S REGISTRY, which the invocation shape does not carry. Those two
// checks are this host's, and the contract places both BEFORE any Cedar
// round-trip: an unknown tool name and schema-invalid arguments each answer
// `failed` WITHOUT dispatch, so malformed provider output never reaches the
// approval pipeline at all.
//
// Spec coverage: `Spec-005 §Required Behavior` (the driver answers every
// callback-tool invocation and invents no approval bypass);
// `Spec-012 §Required Behavior` (every tool invocation is adjudicated, and a
// remembered grant is an evaluation input rather than a bypass);
// `Spec-016 §Provider-Native Subagents` (a child's tool calls route through the
// same pipeline as the parent's).
//
// Refs: Plan-005 §Phase 3 / T3.15 leg 3, CP-005-7, `Spec-005 §Required
// Behavior`, `Spec-012 §Required Behavior`.

import {
  CallbackToolInvocationSchema,
  type CallbackToolInvocation,
  type CallbackToolResult,
  type RunId,
  type SessionCallbackTool,
  type SessionId,
} from "@ai-sidekicks/contracts";

import type { DriverDiagnosticsEmitter, DriverProviderName } from "./driver-diagnostics.js";

// --------------------------------------------------------------------------
// The Plan-012 evaluation seam.
// --------------------------------------------------------------------------

/**
 * One evaluation input, shaped as the canonical `approval.requestCreate`
 * payload Plan-012's composed `check()` consumes.
 *
 * `arguments` rides along because a Cedar policy may condition on the call's
 * own parameters — a path outside the workspace, a host outside the allow-list
 * — and an evaluation that could not see them would be adjudicating the tool
 * rather than the invocation.
 */
export interface CallbackToolApprovalRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * The settled adjudication.
 *
 * `basis` records HOW the outcome was reached, which is what makes the
 * evaluate-first rule observable rather than merely intended: a
 * `participant-*` basis is the only one on which a request was minted, so a
 * host that regressed into minting-first would show up as participant bases on
 * invocations a policy already settled.
 *
 * There is deliberately no third `ask` arm. Minting the request and awaiting
 * the participant's answer belong to the pipeline that owns approval state;
 * exposing an intermediate state here would put this host in the business of
 * tracking pending approvals, which is a second record of something Plan-012
 * already stores durably.
 */
export type CallbackToolApprovalOutcome =
  | {
      readonly decision: "allow";
      readonly basis: "policy" | "remembered-rule" | "participant-grant";
    }
  | {
      readonly decision: "deny";
      readonly basis: "policy" | "remembered-rule" | "participant-refusal";
      readonly reason: string;
    };

/**
 * The port Plan-012's composed `check()` satisfies. Declared here and
 * implemented there: this package authors no Plan-012 symbol, and the daemon
 * composition root binds the two.
 */
export interface CallbackToolApprovalSeam {
  evaluate(request: CallbackToolApprovalRequest): Promise<CallbackToolApprovalOutcome>;
}

// --------------------------------------------------------------------------
// The execution and observability seams.
// --------------------------------------------------------------------------

/**
 * Runs one ADJUDICATED invocation. Reached only after an `allow`, so an
 * executor never has to ask whether it was permitted — a callback tool that
 * re-checked its own authorization would be a second policy decision beside
 * the one Cedar already made.
 */
export interface CallbackToolExecutor {
  execute(invocation: CallbackToolInvocation): Promise<CallbackToolResult>;
}

/** How one invocation settled, for the `tool_activity` row it lands as. */
export type CallbackToolActivityDisposition =
  | "completed"
  | "denied-by-policy"
  | "denied-no-seam"
  | "failed-unknown-tool"
  | "failed-invalid-arguments"
  | "failed-in-execution";

/**
 * One settled invocation, as the event pipeline records it.
 *
 * PRODUCER-ONLY at Plan-005, the same posture `onMcpServerStatus` takes: this
 * host states what happened and the consumer mints the envelope, so no driver-
 * adjacent module composes a `session_events` row.
 */
export interface CallbackToolActivityRecord {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolName: string;
  /** Copied VERBATIM: tool-event pairing is exact-string match. */
  readonly toolCallId: string;
  readonly disposition: CallbackToolActivityDisposition;
  /**
   * The adjudication basis where one was reached, `null` where the invocation
   * was refused before the pipeline was consulted. Never absent-by-omission:
   * an explicit `null` says "no adjudication happened", which is a different
   * fact from "the field was not set".
   */
  readonly approvalBasis: CallbackToolApprovalOutcome["basis"] | null;
}

/** Lands one settled invocation as an ordinary `tool_activity` row. */
export interface CallbackToolActivitySink {
  record(record: CallbackToolActivityRecord): void;
}

// --------------------------------------------------------------------------
// The host.
// --------------------------------------------------------------------------

/** Why a spawn withheld the callback-tool registry from the provider. */
export type CallbackToolRegistryWithholdingReason =
  /** No Plan-012 evaluation seam is registered, so nothing could be adjudicated. */
  | "no-approval-seam"
  /** The provider cannot register the tools at this negotiated posture. */
  | "provider-registration-unavailable";

/** The resolved spawn-time registry: the admitted tools, or a withholding. */
export type CallbackToolRegistryResolution =
  | { readonly admitted: true; readonly tools: readonly SessionCallbackTool[] }
  | {
      readonly admitted: false;
      readonly reason: CallbackToolRegistryWithholdingReason;
      readonly detail: string;
    };

export interface CallbackToolHostOptions {
  readonly provider: DriverProviderName;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly executor: CallbackToolExecutor;
  readonly activitySink: CallbackToolActivitySink;
  /**
   * The Plan-012 evaluation seam. OPTIONAL by design rather than by oversight:
   * the daemon must be able to run before Plan-012's pipeline is composed, and
   * the two fail-closed behaviours above are what make that safe.
   */
  readonly approvalSeam?: CallbackToolApprovalSeam | undefined;
}

/**
 * The daemon-side callback-tool dispatcher.
 *
 * A class rather than a closure factory because it holds real state — the
 * per-session registries the two registry-dependent checks read — and because
 * its entry points are consumed at different moments: the registry resolution
 * at spawn, the dispatcher for the whole session, and the per-session teardown.
 *
 * ---------------------------------------------------------------------------
 * WIRING — the composition root's obligation, in order
 * ---------------------------------------------------------------------------
 *
 * This host is NOT reachable from a driver, and that is deliberate: a driver
 * that constructed or looked up its own host would bind the provider band to
 * the approval band, and one of the two would then have to know about the
 * other's lifetime. The daemon's composition root owns both and wires them per
 * spawn:
 *
 *   1. `resolveSpawnRegistry({ sessionId, requestedTools, ... })` — installs
 *      the session's registry and answers which tools may be offered.
 *   2. Spawn the session passing `callbackTools: resolution.tools` (an empty
 *      list on a withholding) and `onCallbackToolCall: (invocation) =>
 *      host.dispatch(invocation)`.
 *   3. `forgetSession(sessionId)` at teardown.
 *
 * STEP 1 BEFORE STEP 2 IS LOAD-BEARING. `dispatch` refuses any invocation whose
 * session has no installed registry, so a spawn that bound the dispatcher
 * without resolving first would advertise tools the host answers
 * `failed-unknown-tool` to — the exact served-but-unanswerable state leg 3's
 * fail-closed rule exists to prevent. Each driver independently refuses to
 * advertise tools with no dispatcher bound, so the two checks compose into
 * "advertised ⟹ resolved ∧ dispatchable" rather than overlapping.
 */
export class CallbackToolHost {
  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #executor: CallbackToolExecutor;
  readonly #activitySink: CallbackToolActivitySink;
  readonly #approvalSeam: CallbackToolApprovalSeam | undefined;
  readonly #registriesBySessionId = new Map<SessionId, ReadonlyMap<string, SessionCallbackTool>>();

  constructor(options: CallbackToolHostOptions) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#executor = options.executor;
    this.#activitySink = options.activitySink;
    this.#approvalSeam = options.approvalSeam;
  }

  /** Whether an invocation reaching this host can be adjudicated at all. */
  get canAdjudicate(): boolean {
    return this.#approvalSeam !== undefined;
  }

  /**
   * Resolve the callback-tool registry a spawn may offer the provider, and
   * remember it for the session's dispatch checks.
   *
   * `providerRegistrationAvailable` is the DRIVER's fact, not this host's: only
   * the driver knows whether its provider can accept a tool registration at the
   * posture it negotiated. Passing it in keeps the withholding decision in one
   * place while leaving each provider's own gate where it is known.
   *
   * A withholding is recorded and returned, never thrown: a session whose
   * callback tools are unavailable is a degraded session, not a failed one.
   */
  resolveSpawnRegistry(request: {
    readonly sessionId: SessionId;
    readonly requestedTools: readonly SessionCallbackTool[] | undefined;
    readonly providerRegistrationAvailable: boolean;
    readonly providerRegistrationUnavailableDetail: string;
  }): CallbackToolRegistryResolution {
    // Nothing requested is not a withholding: the daemon offered no tools, so
    // there is nothing to withhold and nothing to report. The registry is still
    // installed (empty) so a stray invocation on this session is refused as an
    // unknown tool rather than as a session this host never saw.
    const requestedTools = request.requestedTools ?? [];
    if (requestedTools.length === 0) {
      this.#registriesBySessionId.set(request.sessionId, new Map());
      return { admitted: true, tools: [] };
    }

    if (this.#approvalSeam === undefined) {
      return this.#withholdRegistry(
        request.sessionId,
        "no-approval-seam",
        "no approval evaluation seam is registered, so no invocation could be adjudicated",
        requestedTools.length,
      );
    }
    if (!request.providerRegistrationAvailable) {
      return this.#withholdRegistry(
        request.sessionId,
        "provider-registration-unavailable",
        request.providerRegistrationUnavailableDetail,
        requestedTools.length,
      );
    }

    const registry = new Map<string, SessionCallbackTool>();
    for (const tool of requestedTools) {
      registry.set(tool.name, tool);
    }
    this.#registriesBySessionId.set(request.sessionId, registry);
    return { admitted: true, tools: requestedTools };
  }

  /** Forget one session's registry. Called by the driver at session teardown. */
  forgetSession(sessionId: SessionId): void {
    this.#registriesBySessionId.delete(sessionId);
  }

  /**
   * Record one provider ask the driver band could not turn into a
   * `CallbackToolInvocation` at all, so it never reached {@link dispatch}.
   *
   * WHY THIS EXISTS AS A HOST METHOD RATHER THAN A SECOND DIAGNOSTIC PATH. The
   * host's stated posture is that BOTH its refusals are recorded rather than
   * silent, and an ask refused one layer earlier is refused for the same
   * reason class — the daemon would not answer without adjudication. Handing
   * the adapter its own `DriverDiagnosticsEmitter` would give one provider band
   * two independent emitters that could disagree about the provider label; this
   * routes the record through the emitter and provider identity the host
   * already holds. It reuses `callback_tool_invocation_refused` rather than
   * minting a kind: the condition it reports — an invocation refused before any
   * adjudication — is the one that kind already names.
   *
   * NO `tool_activity` ROW ACCOMPANIES IT, and the omission is structural
   * rather than a choice: `CallbackToolActivityRecord` requires a `RunId` and a
   * `toolCallId`, and an ask that could not form an invocation is precisely one
   * that may be missing either. Fabricating them to satisfy the row would put a
   * turn's identity on a record the provider never supplied.
   */
  recordUnformedInvocation(refusal: {
    readonly sessionId: SessionId;
    readonly runId: RunId | null;
    /** The provider's own name for the tool, or `null` where it supplied none. */
    readonly toolName: string | null;
    readonly toolCallId: string | null;
    readonly detail: string;
  }): void {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "callback_tool_invocation_refused",
      rawWireType: null,
      dispositionReason: refusal.detail,
      details: {
        sessionId: refusal.sessionId,
        runId: refusal.runId,
        // UNTRUSTED provider output, carried verbatim as data on the same
        // reasoning `#refuseInvocation` carries it: an operator needs to see
        // which ask was refused, and it is never interpolated into anything
        // executed.
        toolName: refusal.toolName,
        toolCallId: refusal.toolCallId,
      },
    });
  }

  /**
   * Dispatch one invocation and answer it. This is the function the driver
   * binds as `onCallbackToolCall`.
   *
   * ORDER IS THE CONTRACT: availability, then registry resolution, then
   * argument validation, then adjudication, then execution.
   *
   * AVAILABILITY IS FIRST, and that placement is the fail-closed rule rather
   * than a shortcut. A host with no seam can adjudicate NOTHING, so every
   * invocation reaching it is refused for that one reason — answered `denied`,
   * which says the daemon refused a well-formed call, rather than `failed`,
   * which would blame the provider for a registration the daemon itself
   * withheld. Ordering it after the registry check would make this arm
   * unreachable: a withholding installs an EMPTY registry, so the only
   * invocations that could ever reach a seam check are ones a seam had already
   * admitted.
   *
   * The two pre-checks then answer `failed` WITHOUT dispatch, so malformed
   * provider output never reaches the approval pipeline.
   */
  async dispatch(invocation: CallbackToolInvocation): Promise<CallbackToolResult> {
    const approvalSeam = this.#approvalSeam;
    if (approvalSeam === undefined) {
      // The runtime backstop. Reachable even though the spawn withholding
      // exists, because a provider can carry a tool registration this daemon
      // did not perform — an earlier connection's, or a build that offers one
      // of its own.
      return this.#refuseInvocation(
        invocation,
        "denied",
        "denied-no-seam",
        "callback_tool_seam_absent",
        "no approval evaluation seam is registered; refusing rather than completing without adjudication",
      );
    }

    const registry = this.#registriesBySessionId.get(invocation.sessionId);
    const tool = registry?.get(invocation.toolName);
    if (tool === undefined) {
      return this.#refuseInvocation(
        invocation,
        "failed",
        "failed-unknown-tool",
        "callback_tool_invocation_refused",
        registry === undefined
          ? "invocation names a session with no registered callback-tool registry"
          : `invocation names no registered callback tool`,
      );
    }

    const argumentRefusal = describeArgumentRefusal(tool, invocation.arguments);
    if (argumentRefusal !== null) {
      return this.#refuseInvocation(
        invocation,
        "failed",
        "failed-invalid-arguments",
        "callback_tool_invocation_refused",
        argumentRefusal,
      );
    }

    // A seam that THREW did not adjudicate, so the outcome is the same as a
    // seam that was never registered: refused, never completed. Letting the
    // rejection escape `dispatch` would leave the invocation unanswered and
    // hang the provider's turn — the one outcome this host exists to make
    // impossible — and the executor below is already contained on exactly this
    // reasoning. The refusal reuses the seam-absent disposition rather than
    // minting a diagnostic kind, because "no adjudication happened" is the
    // condition both arms report; the reason text carries the distinction.
    let outcome: CallbackToolApprovalOutcome;
    try {
      outcome = await approvalSeam.evaluate({
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        toolName: invocation.toolName,
        toolCallId: invocation.toolCallId,
        arguments: invocation.arguments,
      });
    } catch (cause) {
      return this.#refuseInvocation(
        invocation,
        "denied",
        "denied-no-seam",
        "callback_tool_seam_absent",
        `the approval evaluation seam threw before adjudicating; refusing rather than completing without adjudication (${describeExecutorFailure(cause)})`,
      );
    }
    if (outcome.decision === "deny") {
      this.#recordActivity(invocation, "denied-by-policy", outcome.basis);
      return { status: "denied", error: outcome.reason };
    }

    // Execution failures are the TOOL's outcome, not the pipeline's: the
    // invocation was adjudicated and allowed, so it lands as an allowed
    // `tool_activity` row that failed, never as a refusal. A throwing executor
    // is normalized rather than propagated — an unanswered invocation would
    // hang the provider's turn, which is the one outcome this host exists to
    // make impossible.
    try {
      const result = await this.#executor.execute(invocation);
      this.#recordActivity(
        invocation,
        result.status === "completed" ? "completed" : "failed-in-execution",
        outcome.basis,
      );
      return result;
    } catch (cause) {
      this.#recordActivity(invocation, "failed-in-execution", outcome.basis);
      return { status: "failed", error: describeExecutorFailure(cause) };
    }
  }

  #withholdRegistry(
    sessionId: SessionId,
    reason: CallbackToolRegistryWithholdingReason,
    detail: string,
    withheldToolCount: number,
  ): CallbackToolRegistryResolution {
    // The registry is installed EMPTY rather than left absent: a provider that
    // invokes anyway must be refused as an unknown tool on a known session, and
    // an absent registry would make that refusal indistinguishable from an
    // invocation naming a session this host never spawned.
    this.#registriesBySessionId.set(sessionId, new Map());
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "callback_tool_registry_withheld",
      rawWireType: null,
      dispositionReason: detail,
      details: { sessionId, reason, withheldToolCount },
    });
    return { admitted: false, reason, detail };
  }

  #refuseInvocation(
    invocation: CallbackToolInvocation,
    status: "denied" | "failed",
    disposition: CallbackToolActivityDisposition,
    diagnosticKind: "callback_tool_seam_absent" | "callback_tool_invocation_refused",
    detail: string,
  ): CallbackToolResult {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: diagnosticKind,
      rawWireType: null,
      dispositionReason: detail,
      details: {
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        // UNTRUSTED provider output, carried verbatim as data so an operator can
        // see which name was refused; never interpolated into anything executed.
        toolName: invocation.toolName,
        toolCallId: invocation.toolCallId,
      },
    });
    this.#recordActivity(invocation, disposition, null);
    return status === "denied"
      ? { status: "denied", error: detail }
      : { status: "failed", error: detail };
  }

  #recordActivity(
    invocation: CallbackToolInvocation,
    disposition: CallbackToolActivityDisposition,
    approvalBasis: CallbackToolApprovalOutcome["basis"] | null,
  ): void {
    // Contained: an activity sink that throws must not turn a settled
    // invocation into an unanswered one. The invocation's ANSWER is the
    // guarantee; the row is observability beside it.
    try {
      this.#activitySink.record({
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        toolName: invocation.toolName,
        toolCallId: invocation.toolCallId,
        disposition,
        approvalBasis,
      });
    } catch {
      /* the answer is already decided; a failing sink must not unmake it */
    }
  }
}

// --------------------------------------------------------------------------
// Argument admission.
// --------------------------------------------------------------------------

/**
 * Describe why an invocation's arguments are refused, or `null` to admit them.
 *
 * DELIBERATELY BOUNDED, and the bound is the honest part: this is not a JSON
 * Schema validator and does not pretend to be one. It enforces the two
 * properties a schema-shaped registry entry states unambiguously and that a
 * malformed provider payload violates first — that an object-typed tool is
 * called with an object, and that its declared `required` properties are
 * present — and it admits everything else for the tool implementation to
 * reject on its own terms.
 *
 * Writing a partial validator that silently accepted the cases it could not
 * check would be worse than this: it would read as validation while providing
 * a subset of it. Naming the subset is what keeps the guarantee truthful.
 */
export function describeArgumentRefusal(
  tool: SessionCallbackTool,
  invocationArguments: Readonly<Record<string, unknown>>,
): string | null {
  const declaredType = tool.inputSchema["type"];
  if (declaredType !== undefined && declaredType !== "object") {
    // A non-object input schema cannot be satisfied by the contract's own
    // `Record<string, unknown>` argument shape, so such a tool is
    // uninvocable through this path by construction rather than by policy.
    return `registered callback tool declares a non-object input schema (${String(declaredType)}), which this invocation shape cannot satisfy`;
  }
  const declaredRequired = tool.inputSchema["required"];
  if (!Array.isArray(declaredRequired)) {
    return null;
  }
  const missingProperties = declaredRequired.filter(
    (propertyName): propertyName is string =>
      typeof propertyName === "string" &&
      !Object.prototype.hasOwnProperty.call(invocationArguments, propertyName),
  );
  if (missingProperties.length === 0) {
    return null;
  }
  return `invocation omits required argument(s) declared by the registered input schema: ${missingProperties.join(", ")}`;
}

/** Normalizes an executor throw into a bounded, leak-safe detail string. */
function describeExecutorFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return "The callback-tool executor failed with no describable detail.";
}

// --------------------------------------------------------------------------
// Composition-root binding.
// --------------------------------------------------------------------------

/**
 * One spawn's worth of callback-tool wiring: what to offer the provider, what
 * to hand it as its dispatcher, and how to let the session go.
 *
 * The three-step obligation documented on {@link CallbackToolHost} is easy to
 * perform out of order and easy to perform partially, and both mistakes are
 * silent — a spawn that bound the dispatcher without resolving first advertises
 * tools every invocation is refused for, and a teardown that forgot
 * `forgetSession` leaks one registry per session for the daemon's lifetime.
 * This value makes the three inseparable: a caller that holds it has already
 * performed step 1 and cannot reach step 2 without the products of step 1.
 *
 * NO PRODUCTION COMPOSITION ROOT CALLS `release` YET, and that is a RECORDED
 * RESIDUAL rather than an oversight: no composition root constructs a driver at
 * all today, so this binder rides the first one alongside the two other
 * bindings waiting on it — `CodexDriverOptions.resolveCredentialEnvPolicy` and
 * both drivers' `modelCatalogExchange`.
 */
export interface CallbackToolSpawnBinding {
  /** Step 1's answer, carried through so a caller can report a withholding. */
  readonly resolution: CallbackToolRegistryResolution;
  /**
   * The value for `CreateSessionParams.callbackTools` / the resume equivalent.
   * A fresh mutable array because the spawn params declare a mutable one, and
   * handing over the resolution's own `readonly` list would let a driver's
   * later mutation reach back into this host's answer.
   */
  readonly callbackTools: SessionCallbackTool[];
  /**
   * The value for `CreateSessionParams.onCallbackToolCall`.
   *
   * BOUND EVEN ON A WITHHOLDING, deliberately. The registry is empty then, so
   * this daemon advertises nothing — but a provider can carry a registration
   * this daemon did not perform (an earlier connection's, or a build offering
   * one of its own), and the host's runtime backstop is what turns that stray
   * invocation into a recorded refusal instead of an unanswered frame. Leaving
   * it unbound would trade a recorded refusal for a silent one.
   */
  readonly onCallbackToolCall: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>;
  /** Step 3. Idempotent, so a teardown path that runs twice is harmless. */
  readonly release: () => void;
}

/**
 * Perform step 1 and compose steps 2 and 3 into one value.
 *
 * A free function rather than a host method because it is the COMPOSITION
 * ROOT's operation, not the host's: it exists to shape what a caller hands a
 * driver, and putting it on the host would suggest the host knows what a spawn
 * looks like. The host still owns every decision it makes.
 */
export function bindCallbackToolsForSpawn(
  host: CallbackToolHost,
  request: {
    readonly sessionId: SessionId;
    readonly requestedTools: readonly SessionCallbackTool[] | undefined;
    readonly providerRegistrationAvailable: boolean;
    readonly providerRegistrationUnavailableDetail: string;
  },
): CallbackToolSpawnBinding {
  const resolution = host.resolveSpawnRegistry(request);
  return {
    resolution,
    callbackTools: resolution.admitted ? [...resolution.tools] : [],
    onCallbackToolCall: async (invocation) => await host.dispatch(invocation),
    release: () => {
      host.forgetSession(request.sessionId);
    },
  };
}

/**
 * Translate a PROVIDER-FACING tool name back to the registry name the host
 * adjudicates, or return it unchanged when the map does not know it.
 *
 * Only one transport needs this today — the Claude leg hosts the registry as an
 * ephemeral MCP server, where every tool surfaces mangled as
 * `mcp__<server>__<tool>` — but the translation belongs beside the host rather
 * than inside that transport, because a transport that forgot to perform it
 * would hand the host a name no registry holds and reach `failed-unknown-tool`:
 * the served-but-unanswerable state this leg exists to prevent, arrived at from
 * the opposite direction.
 *
 * AN UNKNOWN NAME PASSES THROUGH UNCHANGED rather than refusing here. The host
 * is the single place that decides what is registered, and passing the
 * provider's own name into that decision is what puts the exact string the
 * provider used into the refusal's diagnostic — which is the string an operator
 * needs to see.
 */
export function resolveRegisteredCallbackToolName(
  registryNamesByProviderName: ReadonlyMap<string, string>,
  providerFacingToolName: string,
): string {
  return registryNamesByProviderName.get(providerFacingToolName) ?? providerFacingToolName;
}

// --------------------------------------------------------------------------
// The routed-ask adapter.
// --------------------------------------------------------------------------

/**
 * One inbound provider ask carrying the session and run identity the daemon
 * needs to adjudicate it.
 *
 * DECLARED HERE rather than imported from the Codex band, on the same reasoning
 * that band declares its responder port rather than importing this host: each
 * side names the shape it needs and the composition root proves they match. The
 * proof is structural and it is a COMPILE-TIME one — `createCallbackToolAskResponder`'s
 * return value is passed as `CodexDriverOptions.answerServerRequest`, so a
 * divergence between the two declarations is a type error at that call site
 * rather than a runtime surprise.
 */
export interface RoutedProviderAsk {
  /** The provider's own method name, verbatim and untrusted; a label only. */
  readonly method: string;
  readonly askKind: "callback-tool" | "approval";
  /** The raw wire params, untrusted; this adapter parses what it needs. */
  readonly params: unknown;
  readonly sessionId: SessionId;
  /** `null` when no turn is active — establishment, or after a turn retired. */
  readonly runId: RunId | null;
}

/** The daemon's answer to one routed ask. */
export type RoutedProviderAskDecision =
  | { readonly decision: "allow"; readonly payload?: Record<string, unknown> | undefined }
  | { readonly decision: "refuse"; readonly reason: string };

/** The port a provider band binds to have its routed asks answered. */
export interface RoutedProviderAskResponder {
  answer(request: RoutedProviderAsk): Promise<RoutedProviderAskDecision>;
}

export interface CallbackToolAskResponderOptions {
  readonly host: CallbackToolHost;
  /**
   * The responder for `askKind: "approval"` asks — Plan-012's, whose questions
   * are permission decisions rather than tool calls — or an EXPLICIT `null` for
   * a daemon composed without one.
   *
   * REQUIRED-BUT-NULLABLE rather than optional, on the reasoning that makes
   * `resolveCredentialEnvPolicy` required: one responder answers BOTH ask kinds
   * because the provider band binds exactly one port, so this adapter
   * unavoidably stands in front of the approval methods too. An optional arm
   * would let a composition root that simply never bound Plan-012's responder
   * refuse every approval without anyone having decided to.
   */
  readonly approvalAskResponder: RoutedProviderAskResponder | null;
}

/**
 * Compose the responder a provider band binds for its routed asks: callback
 * tool calls answered by this daemon's {@link CallbackToolHost}, approval asks
 * delegated to Plan-012's responder.
 *
 * EVERY PATH ANSWERS. The band this feeds turns a refusal into the asking
 * method's own refusal shape, so a refusal here answers the question that was
 * asked rather than reporting a protocol fault.
 */
export function createCallbackToolAskResponder(
  options: CallbackToolAskResponderOptions,
): RoutedProviderAskResponder {
  const { host, approvalAskResponder } = options;
  return {
    async answer(request: RoutedProviderAsk): Promise<RoutedProviderAskDecision> {
      if (request.askKind === "approval") {
        if (approvalAskResponder === null) {
          // No diagnostic is emitted, and the omission is deliberate: the
          // `callback_tool_*` kinds name this host's own conditions, and
          // labelling an approval refusal with one would misattribute it. The
          // refusal is not silent — the reason travels to the provider on the
          // method's own refusal shape — and the approval band owns the
          // observability for the questions it is meant to answer.
          return {
            decision: "refuse",
            reason: `The daemon has no approval responder registered for "${request.method}"; refusing rather than answering without adjudication.`,
          };
        }
        return await approvalAskResponder.answer(request);
      }

      const invocation = readCallbackToolInvocation(request);
      if (typeof invocation === "string") {
        host.recordUnformedInvocation({
          sessionId: request.sessionId,
          runId: request.runId,
          toolName: readOptionalWireString(request.params, "tool"),
          toolCallId: readOptionalWireString(request.params, "callId"),
          detail: invocation,
        });
        return { decision: "refuse", reason: invocation };
      }

      const result = await host.dispatch(invocation);
      if (result.status !== "completed") {
        return {
          decision: "refuse",
          reason:
            result.error ?? "The daemon refused this callback tool call with no stated reason.",
        };
      }
      return {
        decision: "allow",
        payload: { contentItems: composeCallbackToolContentItems(result.output) },
      };
    },
  };
}

/**
 * Build the `CallbackToolInvocation` one routed ask carries, or describe why it
 * cannot be built.
 *
 * A `string` return is the refusal reason, which is why it is not `null`: an
 * ask this daemon will not answer must say WHAT it could not read, both to the
 * provider and to the diagnostic.
 *
 * The field names are the pinned generation's own `DynamicToolCallParams`
 * (`tool`, `callId`, `arguments`, plus `threadId` / `turnId` / `namespace`,
 * which the daemon's own routing already supplies and this shape therefore does
 * not read). `arguments` is schema-typed as ANY JSON VALUE there — not an
 * object — so a non-object argument payload is a shape the provider is entitled
 * to send and this adapter is obliged to refuse rather than assume away.
 */
function readCallbackToolInvocation(request: RoutedProviderAsk): CallbackToolInvocation | string {
  // Ordered ahead of the shape read because it is not a malformed-payload
  // condition at all: a well-formed call raised outside any active turn simply
  // cannot be attributed, and `CallbackToolInvocation.runId` is required
  // precisely so no invocation is adjudicated against an invented run.
  if (request.runId === null) {
    return `The provider raised "${request.method}" with no turn active on the session, so the call cannot be attributed to a run; refusing rather than adjudicating it against an invented one.`;
  }
  const parsedInvocation = CallbackToolInvocationSchema.safeParse({
    toolName: readWireValue(request.params, "tool"),
    arguments: readWireValue(request.params, "arguments"),
    toolCallId: readWireValue(request.params, "callId"),
    sessionId: request.sessionId,
    runId: request.runId,
  });
  if (!parsedInvocation.success) {
    return `The provider's "${request.method}" params did not parse as a callback-tool invocation; refusing rather than dispatching a malformed call.`;
  }
  return parsedInvocation.data;
}

/** One member of an untrusted wire params object, or `undefined`. */
function readWireValue(params: unknown, memberName: string): unknown {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  return (params as Record<string, unknown>)[memberName];
}

/** The same read, narrowed to the string case, for a diagnostic's detail field. */
function readOptionalWireString(params: unknown, memberName: string): string | null {
  const value = readWireValue(params, memberName);
  return typeof value === "string" ? value : null;
}

/** The three content-item arms the pinned generation's response type declares. */
const CALLBACK_TOOL_CONTENT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "inputText",
  "inputImage",
  "inputAudio",
]);

/**
 * Render a completed tool's `output` as the content-item array the provider's
 * response type requires.
 *
 * THE SILENT-LOSS ARM THIS EXISTS TO CLOSE. `CallbackToolResult.output` is
 * typed `unknown` — an executor may answer with a string, a number, or an
 * object — while the response's `contentItems` is an array of a CLOSED
 * three-arm union. Handing the raw value through would answer the provider
 * `success` with an empty or malformed content array, and the model would read
 * a tool that completed and returned nothing. A tool that produced an answer
 * nobody can see is worse than one that failed, because nothing reports it.
 *
 * So: an ALREADY-WELL-FORMED array passes through untouched (an executor that
 * composed content items meant them), an ABSENT output is a genuine empty
 * result, and EVERYTHING ELSE is wrapped as a single `inputText` item — the arm
 * the refusal path already uses, so this adapter introduces no vocabulary of
 * its own.
 */
export function composeCallbackToolContentItems(output: unknown): unknown[] {
  if (output === undefined) {
    return [];
  }
  if (Array.isArray(output) && output.every(isWellFormedContentItem)) {
    return [...output];
  }
  return [{ type: "inputText", text: renderContentItemText(output) }];
}

function isWellFormedContentItem(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const itemType = (candidate as Record<string, unknown>)["type"];
  return typeof itemType === "string" && CALLBACK_TOOL_CONTENT_ITEM_TYPES.has(itemType);
}

/**
 * Render one non-content-item output as text.
 *
 * A value that cannot be serialized at all — a cycle, a `BigInt` — still
 * produces a visible item rather than an exception: the executor's answer has
 * already been adjudicated and allowed, and letting a rendering failure escape
 * would convert a completed tool call into an unanswered frame.
 */
function renderContentItemText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    const serialized = JSON.stringify(output);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    /* fall through to the un-renderable answer below */
  }
  return "The callback tool completed with an output this daemon could not render as text.";
}

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
  DRIVER_TOOL_CALL_ID_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
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
  | "failed-superseded-binding"
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

/**
 * Identifies ONE installation of ONE session's callback-tool registry.
 *
 * WHY A SESSION ID IS NOT ENOUGH, which is the entire reason this exists. A
 * resume or a relaunch installs a fresh registry under the SAME session id
 * while the superseded provider process is still winding down. Keyed by session
 * id alone, that process's teardown deletes the REPLACEMENT's registry, and its
 * still-in-flight callbacks are adjudicated against the REPLACEMENT's
 * registered tools — one spawn reaching into a sibling spawn's state, on both
 * paths, with nothing reporting either. A token minted per installation makes
 * the two distinguishable: the host acts for the binding whose token is still
 * the installed one, and records a refusal for a binding whose is not.
 *
 * IDENTITY IS BY REFERENCE, never by the ordinal. The ordinal exists so a
 * diagnostic can name WHICH installation was superseded; comparing it instead
 * would let any caller synthesize a token that matches.
 */
export interface CallbackToolRegistryToken {
  /** Daemon-local installation ordinal. Diagnostics only — see above. */
  readonly installation: number;
}

/**
 * The resolved spawn-time registry: the admitted tools, or a withholding.
 *
 * `registryToken` rides BOTH arms, including the withholding, and that is not
 * symmetry for its own sake: a withholding still INSTALLS a registry (an empty
 * one, so a stray invocation is refused as an unknown tool on a known session),
 * so a withheld spawn still has an installation a later spawn can supersede and
 * still owes a scoped teardown. Omitting the token there would leave exactly
 * the withheld spawns tearing down their successors.
 */
export type CallbackToolRegistryResolution =
  | {
      readonly admitted: true;
      readonly tools: readonly SessionCallbackTool[];
      readonly registryToken: CallbackToolRegistryToken;
    }
  | {
      readonly admitted: false;
      readonly reason: CallbackToolRegistryWithholdingReason;
      readonly detail: string;
      readonly registryToken: CallbackToolRegistryToken;
    };

/** One session's currently-installed registry, and the token that installed it. */
interface InstalledCallbackToolRegistry {
  readonly token: CallbackToolRegistryToken;
  readonly toolsByName: ReadonlyMap<string, SessionCallbackTool>;
  /**
   * The installation this one displaced, restorable by
   * {@link CallbackToolHost.rollbackSpawnRegistry} when the spawn that installed
   * this one fails to establish.
   *
   * DEPTH ONE, ALWAYS. The record stored here is itself stripped of its own
   * predecessor, so a session resumed repeatedly holds at most two registries
   * rather than a chain that grows with every attempt. That is not only a memory
   * bound, it is the honest one: an installation two supersedes back has already
   * been displaced by a spawn that SUCCEEDED, and restoring it would revive a
   * registry whose process is gone.
   *
   * It rides the installed record rather than a second map so its lifetime is
   * exactly the installed record's — a registry that is forgotten cannot leave a
   * rollback target behind it.
   */
  readonly superseded: InstalledCallbackToolRegistry | undefined;
}

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
 *      the session's registry, mints the installation's
 *      {@link CallbackToolRegistryToken}, and answers which tools may be
 *      offered.
 *   2. Spawn the session passing `callbackTools: resolution.tools` (an empty
 *      list on a withholding) and `onCallbackToolCall: (invocation) =>
 *      host.dispatch(invocation, resolution.registryToken)`.
 *   3. `forgetSession(sessionId, resolution.registryToken)` at teardown — or
 *      `rollbackSpawnRegistry(sessionId, resolution.registryToken)` where the
 *      spawn in step 2 FAILED, which additionally restores the installation
 *      step 1 displaced. The two are not interchangeable: a failed replacement
 *      released rather than rolled back leaves a live predecessor process whose
 *      every later callback is refused for a registry that is simply absent.
 *
 * CARRYING THE TOKEN THROUGH STEPS 2 AND 3 IS WHAT SCOPES THEM TO THIS SPAWN.
 * Without it, a resume that installed a replacement registry before the
 * superseded process finished winding down would have that process's teardown
 * delete the live registry and its late callbacks adjudicated against the live
 * registry's tools. {@link bindCallbackToolsForSpawn} performs this threading,
 * which is the reason to prefer it over calling the three entry points by
 * hand.
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
  readonly #registriesBySessionId = new Map<SessionId, InstalledCallbackToolRegistry>();
  /** Monotonic within one host, so no two live installations share an ordinal. */
  #nextRegistryInstallation = 1;

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
      return {
        admitted: true,
        tools: [],
        registryToken: this.#installRegistry(request.sessionId, []),
      };
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

    // CLONED AND FROZEN at the boundary, so the host's registry and the list
    // the driver is handed cannot drift apart. The caller keeps its own
    // descriptors and may mutate them; what it may not do is change what this
    // host validates against after the spawn admitted it — a driver that
    // widened an `inputSchema` in place would move the argument admission
    // without passing the spawn-time decision that admitted the tool at all.
    const admittedTools = requestedTools.map(cloneRegisteredCallbackTool);
    return {
      admitted: true,
      tools: Object.freeze(admittedTools),
      registryToken: this.#installRegistry(request.sessionId, admittedTools),
    };
  }

  /**
   * Forget one session's registry, scoped to the installation that asked.
   *
   * `registryToken` is REQUIRED-BUT-NULLABLE rather than optional, on the
   * reasoning that makes `approvalAskResponder` required-but-nullable: every
   * caller must DECIDE. Passing the binding's own token scopes the teardown to
   * that spawn — the shape {@link bindCallbackToolsForSpawn} always produces.
   * Passing `null` is an UNSCOPED teardown that forgets whichever installation
   * is current, which is what a daemon-wide shutdown wants and what a
   * per-spawn teardown must never use: an unscoped release from a superseded
   * spawn is precisely the bug the token exists to close.
   *
   * Idempotent in both directions: a session with nothing installed is a
   * no-op, and a teardown that runs twice deletes once.
   */
  forgetSession(sessionId: SessionId, registryToken: CallbackToolRegistryToken | null): void {
    const installed = this.#registriesBySessionId.get(sessionId);
    if (installed === undefined) {
      return;
    }
    if (registryToken !== null && installed.token !== registryToken) {
      // RECORDED, never silently honoured and never silently dropped: honouring
      // it would tear down the LIVE spawn's registry, and dropping it without a
      // record would leave an operator watching a teardown that did nothing.
      this.#recordReleaseIgnored(sessionId, registryToken, installed.token);
      return;
    }
    this.#registriesBySessionId.delete(sessionId);
  }

  /**
   * Install one session's registry and mint the installation's token.
   *
   * A REPLACEMENT IS RECORDED rather than silent. It is not itself a fault — a
   * resume or a relaunch reaches this legitimately — but it is the moment after
   * which the superseded spawn's dispatcher and teardown stop acting on the
   * session, so an operator reading either of those refusals needs this record
   * to explain them.
   */
  #installRegistry(
    sessionId: SessionId,
    tools: readonly SessionCallbackTool[],
  ): CallbackToolRegistryToken {
    const token: CallbackToolRegistryToken = Object.freeze({
      installation: this.#nextRegistryInstallation,
    });
    this.#nextRegistryInstallation += 1;
    const toolsByName = new Map<string, SessionCallbackTool>();
    for (const tool of tools) {
      toolsByName.set(tool.name, tool);
    }
    const superseded = this.#registriesBySessionId.get(sessionId);
    this.#registriesBySessionId.set(sessionId, {
      token,
      toolsByName,
      // Stripped of ITS own predecessor: see `superseded` on the record type.
      superseded:
        superseded === undefined
          ? undefined
          : { token: superseded.token, toolsByName: superseded.toolsByName, superseded: undefined },
    });
    if (superseded !== undefined) {
      this.#recordRegistryReplacement(
        sessionId,
        "a second spawn installed a callback-tool registry for a session that still had one installed; the superseded installation no longer dispatches or releases",
        superseded.token,
        token,
        toolsByName.size,
      );
    }
    return token;
  }

  /**
   * Undo one installation, restoring the registry it displaced.
   *
   * THE ARM THIS CLOSES. A resume or relaunch resolves its registry BEFORE it
   * spawns — step 1 before step 2 is load-bearing, since a dispatcher bound
   * without a registry advertises tools every invocation is refused for — so a
   * spawn that then FAILS to establish has already superseded a predecessor that
   * is still alive. The Codex resume path deliberately keeps its prior
   * connection live on a failed establishment, and that surviving process's
   * callback closure holds the PREDECESSOR's token: releasing the failed
   * replacement alone deletes only the replacement, so every later tool call
   * from the live process is refused for a registry that is simply absent. The
   * failure is total and permanent for that session, and nothing about it
   * resembles the transient establishment error that caused it.
   *
   * SCOPED EXACTLY AS {@link forgetSession} IS. A rollback naming an
   * installation that is no longer current is a THIRD spawn's problem: it
   * installed after this replacement, so undoing anything here would tear down a
   * live registry to restore a dead one. That case is recorded and ignored,
   * reusing the same kind an out-of-order release takes, because it is the same
   * condition — a superseded spawn's teardown arriving late.
   *
   * DEGENERATES TO A RELEASE where the replacement displaced nothing: there is
   * no predecessor to restore, so the correct end state is the one `release()`
   * produces. That is what makes a rollback safe to call unconditionally on a
   * failed spawn without first asking whether the session had a registry.
   *
   * Idempotent: a second rollback finds either nothing installed or a token it
   * does not own, and both arms already do nothing.
   */
  rollbackSpawnRegistry(sessionId: SessionId, registryToken: CallbackToolRegistryToken): void {
    const installed = this.#registriesBySessionId.get(sessionId);
    if (installed === undefined) {
      return;
    }
    if (installed.token !== registryToken) {
      this.#recordReleaseIgnored(sessionId, registryToken, installed.token);
      return;
    }
    const predecessor = installed.superseded;
    if (predecessor === undefined) {
      this.#registriesBySessionId.delete(sessionId);
      return;
    }
    this.#registriesBySessionId.set(sessionId, predecessor);
    // The RESTORE is a registry replacement like any other and takes the kind
    // that names one: installation N is displaced by installation N-1. Recording
    // it is what keeps an operator's model of which installation is live from
    // going stale at the supersede record this undoes.
    this.#recordRegistryReplacement(
      sessionId,
      "a failed spawn rolled its callback-tool registry back; the installation it had superseded is live again and the failed one no longer dispatches or releases",
      registryToken,
      predecessor.token,
      predecessor.toolsByName.size,
    );
  }

  /** One registry displacing another — an install, or a rollback's restore. */
  #recordRegistryReplacement(
    sessionId: SessionId,
    dispositionReason: string,
    supersededToken: CallbackToolRegistryToken,
    installedToken: CallbackToolRegistryToken,
    installedToolCount: number,
  ): void {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "callback_tool_registry_superseded",
      rawWireType: null,
      dispositionReason,
      details: {
        sessionId,
        supersededInstallation: supersededToken.installation,
        installedInstallation: installedToken.installation,
        installedToolCount,
      },
    });
  }

  /** A scoped teardown or rollback that arrived after its installation was replaced. */
  #recordReleaseIgnored(
    sessionId: SessionId,
    releasingToken: CallbackToolRegistryToken,
    installedToken: CallbackToolRegistryToken,
  ): void {
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "callback_tool_registry_release_ignored",
      rawWireType: null,
      dispositionReason:
        "a superseded spawn's teardown ran after its callback-tool registry had been replaced; leaving the live installation in place",
      details: {
        sessionId,
        releasingInstallation: releasingToken.installation,
        installedInstallation: installedToken.installation,
      },
    });
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
        // UNTRUSTED provider output, carried as data on the same reasoning
        // `#refuseInvocation` carries it — an operator needs to see which ask
        // was refused, and it is never interpolated into anything executed —
        // but BOUNDED, because this arm runs on a payload that never passed
        // `CallbackToolInvocationSchema`: the refusal is often that it could
        // not. An unbounded copy would put a provider-sized string into the
        // emitter's 256-record ring and the log sink behind it.
        sessionId: refusal.sessionId,
        runId: refusal.runId,
        ...describeBoundedWireIdentifier("toolName", refusal.toolName, DRIVER_TOOL_NAME_MAX_LEN),
        ...describeBoundedWireIdentifier(
          "toolCallId",
          refusal.toolCallId,
          DRIVER_TOOL_CALL_ID_MAX_LEN,
        ),
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
   *
   * `registryToken` SCOPES THE CALL TO ONE INSTALLATION, and is
   * required-but-nullable for the same reason {@link forgetSession}'s is: every
   * caller decides. A spawn's own dispatcher passes the token that spawn
   * installed, so a superseded process's late callback is refused rather than
   * adjudicated against its successor's tools. `null` is the UNSCOPED call —
   * whatever registry is installed now — which is correct for a per-driver
   * routed-ask responder that outlives any one spawn and has no token to hold,
   * and wrong for anything holding one.
   */
  async dispatch(
    invocation: CallbackToolInvocation,
    registryToken: CallbackToolRegistryToken | null,
  ): Promise<CallbackToolResult> {
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

    const installed = this.#registriesBySessionId.get(invocation.sessionId);
    if (installed !== undefined && registryToken !== null && installed.token !== registryToken) {
      // Ordered AHEAD of the tool lookup deliberately. A superseded spawn's
      // late callback must be refused because of WHOSE registry it belongs to,
      // never admitted merely because the replacement happens to register a
      // tool by the same name — the replacement's descriptor may carry a
      // different schema, and adjudicating against it would apply the live
      // spawn's admission to a call the live spawn never made.
      return this.#refuseInvocation(
        invocation,
        "failed",
        "failed-superseded-binding",
        "callback_tool_invocation_refused",
        "invocation was raised against a callback-tool registry a later spawn has superseded; refusing rather than adjudicating it against the live spawn's registry",
      );
    }
    const tool = installed?.toolsByName.get(invocation.toolName);
    if (tool === undefined) {
      return this.#refuseInvocation(
        invocation,
        "failed",
        "failed-unknown-tool",
        "callback_tool_invocation_refused",
        installed === undefined
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
    const registryToken = this.#installRegistry(sessionId, []);
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "callback_tool_registry_withheld",
      rawWireType: null,
      dispositionReason: detail,
      details: { sessionId, reason, withheldToolCount },
    });
    return { admitted: false, reason, detail, registryToken };
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
        // UNTRUSTED provider output, carried as data so an operator can see
        // which name was refused; never interpolated into anything executed.
        // Bounded on the same reasoning as `recordUnformedInvocation`'s copy:
        // `dispatch` is a public entry point, so the schema's bound is the
        // routed path's guarantee rather than this method's precondition.
        ...describeBoundedWireIdentifier("toolName", invocation.toolName, DRIVER_TOOL_NAME_MAX_LEN),
        ...describeBoundedWireIdentifier(
          "toolCallId",
          invocation.toolCallId,
          DRIVER_TOOL_CALL_ID_MAX_LEN,
        ),
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

// --------------------------------------------------------------------------
// Bounded diagnostic identifiers.
// --------------------------------------------------------------------------

/**
 * Describe one untrusted provider identifier as bounded diagnostic detail.
 *
 * WHY BOUND AT ALL, given the schema. `CallbackToolInvocationSchema` bounds
 * these strings, but the two call sites that copy them are reached by payloads
 * the schema did NOT admit: `recordUnformedInvocation` runs precisely when the
 * parse failed, and `dispatch` is a public entry point a caller may reach with
 * a hand-built value. So the bound belongs where the copy happens rather than
 * where the happy path validates, and the destination is what makes it matter —
 * the emitter retains 256 records in memory and a log sink serializes each one.
 *
 * TRUNCATION IS MARKED, never inferred: the record carries an explicit
 * `<field>Truncated` flag whenever a string was present, so a value that
 * happens to sit exactly at the bound is not read as a clipped one, and the
 * pre-truncation length rides along so an operator can see how much was cut.
 * Absent (`null`) values carry no flag at all, which keeps "the provider sent
 * no name" distinguishable from "the provider sent a short one".
 */
function describeBoundedWireIdentifier(
  fieldName: string,
  value: string | null,
  maxLength: number,
): Readonly<Record<string, string | number | boolean | null>> {
  if (value === null) {
    return { [fieldName]: null };
  }
  if (value.length <= maxLength) {
    return { [fieldName]: value, [`${fieldName}Truncated`]: false };
  }
  return {
    [fieldName]: truncateAtCodePointBoundary(value, maxLength),
    [`${fieldName}Truncated`]: true,
    [`${fieldName}OriginalLength`]: value.length,
  };
}

/**
 * Cut a string to at most `maxLength` UTF-16 code units without splitting a
 * surrogate pair — a lone surrogate would make the record itself unserializable
 * by some sinks, which would turn a bounding measure into a new failure mode.
 */
function truncateAtCodePointBoundary(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return splitsSurrogatePair ? cut.slice(0, -1) : cut;
}

/**
 * Copy one registry descriptor so the host validates against a value no caller
 * still holds a mutable reference to.
 *
 * The nested `inputSchema` is copied too, and that is the half that matters:
 * `describeArgumentRefusal` reads `type` and `required` out of it on EVERY
 * invocation, so a driver that mutated the object it handed over would move the
 * argument admission after the spawn-time decision that admitted the tool —
 * silently, and with no second adjudication anywhere.
 *
 * DELIBERATELY SHALLOW BELOW THE SCHEMA'S OWN TOP LEVEL, and the bound is the
 * honest part. `required` is re-copied because it is the one nested value the
 * admission actually reads; a deeper structure inside `properties` is shared,
 * and nothing in this host reads it. A structured-clone pass would claim a
 * guarantee this host does not need and would throw on the non-cloneable values
 * a `Record<string, unknown>` may legally hold.
 */
function cloneRegisteredCallbackTool(tool: SessionCallbackTool): SessionCallbackTool {
  const inputSchema: Record<string, unknown> = { ...tool.inputSchema };
  const declaredRequired = inputSchema["required"];
  if (Array.isArray(declaredRequired)) {
    inputSchema["required"] = Object.freeze([...declaredRequired]);
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: Object.freeze(inputSchema),
  });
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
 * NO PRODUCTION COMPOSITION ROOT CALLS `release` OR `rollback` YET, and that is
 * a RECORDED RESIDUAL rather than an oversight: no composition root constructs a
 * driver at all today, so this binder rides the first one alongside the two
 * other bindings waiting on it — `CodexDriverOptions.resolveCredentialEnvPolicy`
 * and both drivers' `modelCatalogExchange`. The obligation the first root
 * inherits is that a FAILED spawn takes `rollback` and a torn-down one takes
 * `release`; the two end states differ only when this spawn displaced a
 * predecessor, which is exactly the case the failure path must not get wrong.
 */
export interface CallbackToolSpawnBinding {
  /** Step 1's answer, carried through so a caller can report a withholding. */
  readonly resolution: CallbackToolRegistryResolution;
  /**
   * The value for `CreateSessionParams.callbackTools` / the resume equivalent.
   * A fresh mutable array because the spawn params declare a mutable one, and
   * handing over the resolution's own `readonly` list would let a driver's
   * later mutation reach back into this host's answer.
   *
   * The DESCRIPTORS inside it are the host's own frozen clones, so a driver
   * that mutated one in place changes neither the host's registry nor the other
   * spawn's copy — it changes a frozen object, which fails loudly under strict
   * mode rather than desyncing the admission silently.
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
  /**
   * Step 3 on the SUCCESS path. Idempotent, so a teardown path that runs twice
   * is harmless, and SCOPED to this spawn's installation, so a superseded
   * spawn's teardown leaves its successor's registry installed and records that
   * it did.
   */
  readonly release: () => void;
  /**
   * Step 3 on the FAILURE path — the spawn in step 2 never established.
   *
   * `release()` is not the right call there, and the difference is not
   * cosmetic. Step 1 already installed this spawn's registry, so a resume or
   * relaunch whose spawn then fails has superseded a predecessor that, on at
   * least one driver, is deliberately still alive. Releasing deletes only this
   * spawn's installation and leaves that surviving process dispatching against
   * nothing; rolling back restores the registry it displaced, which is the
   * state the failed attempt should never have left.
   *
   * Safe to call unconditionally on a failed spawn: where this binding
   * displaced no predecessor, it does exactly what `release()` does.
   */
  readonly rollback: () => void;
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
  const registryToken = resolution.registryToken;
  return {
    resolution,
    callbackTools: resolution.admitted ? [...resolution.tools] : [],
    onCallbackToolCall: async (invocation) => await host.dispatch(invocation, registryToken),
    release: () => {
      host.forgetSession(request.sessionId, registryToken);
    },
    rollback: () => {
      host.rollbackSpawnRegistry(request.sessionId, registryToken);
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

      // UNSCOPED (`null`) deliberately, and the justification is PROVENANCE
      // rather than lifetime. That this responder outlives any single spawn
      // explains why it holds no token; it does not explain why dispatching
      // against whatever registry is installed now is SAFE. What explains that
      // is upstream: a `RoutedProviderAsk` reaches this arm only after the
      // provider band has attributed it to a live run, and the band that
      // routes callback-tool asks today attributes them by the turn the
      // provider itself names, refusing any it holds no live route for. A
      // superseded spawn's turns live on the session record the supersede
      // displaced, so its invocation is refused BEFORE it reaches here and the
      // laundering this arm cannot detect is one it can never be handed.
      //
      // The obligation that carries: a band routing callback-tool asks WITHOUT
      // turn-keyed attribution would break that argument, not this code. Such
      // a band owes a per-spawn token on the ask — the binding closure below
      // already carries one — because at this boundary the invocation names no
      // spawn and none can be inferred.
      const result = await host.dispatch(invocation, null);
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

/**
 * The three content-item arms the pinned generation's response type declares,
 * each mapped to the ONE member that arm requires beside its discriminator.
 *
 * `DynamicToolCallOutputContentItem` is a closed union of exactly
 * `{ type: "inputText", text: string }`, `{ type: "inputImage", imageUrl: string }`,
 * and `{ type: "inputAudio", audioUrl: string }`. Keying the required member by
 * arm is what makes the admission below a check of the union rather than a
 * check of the discriminator: `{ type: "inputText" }` names a real arm and is
 * still not a value that union can hold.
 */
const CALLBACK_TOOL_CONTENT_ITEM_REQUIRED_MEMBERS: ReadonlyMap<string, string> = new Map([
  ["inputText", "text"],
  ["inputImage", "imageUrl"],
  ["inputAudio", "audioUrl"],
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
 * So: an ALREADY-WELL-FORMED array is REBUILT arm by arm (an executor that
 * composed content items meant them, so every one of them survives), an ABSENT
 * output is a genuine empty result, and EVERYTHING ELSE is wrapped as a single
 * `inputText` item — the arm the refusal path already uses, so this adapter
 * introduces no vocabulary of its own.
 *
 * REBUILT, NOT PASSED THROUGH, and the difference is a second silent-loss arm.
 * A well-formed item may carry SIBLING members beside its discriminator and
 * required member, and those members are executor-supplied `unknown`: a
 * `BigInt`, a cycle, a getter that throws. The provider frame is serialized
 * downstream of this function and outside its `try`, so one unserializable
 * sibling on an otherwise perfect item throws at the write and leaves the
 * callback ask UNANSWERED — the provider waits forever on a tool the daemon
 * already ran. Rebuilding each admitted item from exactly its discriminator and
 * its one required member — both proven `string` by the check below — makes the
 * returned array serializable BY CONSTRUCTION rather than by inspection. What
 * is lost is only members the pinned union does not declare, which the provider
 * would have ignored or rejected; what is kept is every item, in order.
 *
 * WELL-FORMED IS CHECKED PER ARM, not per discriminator, and the difference is
 * the whole guarantee. An item naming a real arm while omitting that arm's
 * required member — `{ type: "inputText" }`, an `inputImage` with no
 * `imageUrl` — is a value the provider's closed union cannot hold, so shipping
 * it would answer `success` with a payload the provider rejects or renders as
 * nothing: the silent loss this function exists to close, arrived at through
 * the pass-through arm instead of the wrapping one.
 *
 * ONE MALFORMED ITEM ROUTES THE WHOLE OUTPUT through the render-as-text
 * fallback, and it is the whole output rather than the offending item because
 * the alternatives are both worse: dropping the item silently loses part of an
 * answer the model is told it received in full, and mixing rendered text into a
 * partially-structured array reorders content the executor composed in a
 * meaningful order. Rendering the whole value keeps everything the tool
 * produced visible, in the order it produced it.
 */
export function composeCallbackToolContentItems(output: unknown): unknown[] {
  if (output === undefined) {
    return [];
  }
  if (Array.isArray(output)) {
    const rebuilt = rebuildContentItems(output);
    if (rebuilt !== null) {
      return rebuilt;
    }
  }
  return [{ type: "inputText", text: renderContentItemText(output) }];
}

/**
 * Every candidate rebuilt from its own arm, or `null` if ANY of them is not a
 * value the provider's closed union can hold.
 *
 * `null` rather than a shorter array: one malformed item routes the WHOLE
 * output through the text fallback, for the reason stated above the caller.
 */
function rebuildContentItems(candidates: readonly unknown[]): unknown[] | null {
  const rebuilt: unknown[] = [];
  for (const candidate of candidates) {
    const item = rebuildContentItem(candidate);
    if (item === null) {
      return null;
    }
    rebuilt.push(item);
  }
  return rebuilt;
}

/** One admitted item reduced to its two declared members, or `null`. */
function rebuildContentItem(candidate: unknown): Record<string, string> | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const item = candidate as Record<string, unknown>;
  const itemType = item["type"];
  if (typeof itemType !== "string") {
    return null;
  }
  const requiredMemberName = CALLBACK_TOOL_CONTENT_ITEM_REQUIRED_MEMBERS.get(itemType);
  if (requiredMemberName === undefined) {
    return null;
  }
  // The member must be a NON-EMPTY string: the union types all three as
  // `string`, and an empty one is the same invisible answer a missing one is —
  // an image item with `imageUrl: ""` resolves to nothing the model can see.
  const requiredMember = item[requiredMemberName];
  if (typeof requiredMember !== "string" || requiredMember.length === 0) {
    return null;
  }
  // Only the two members the arm declares, both already proven `string`. This
  // is the line that makes the result serializable by construction.
  return { type: itemType, [requiredMemberName]: requiredMember };
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

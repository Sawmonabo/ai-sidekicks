// Callback-tool host: the daemon-side dispatcher behind `CreateSessionParams.onCallbackToolCall`.
// A driver turns its provider's wire request into a `CallbackToolInvocation`, hands it here, and
// answers the provider with the returned `CallbackToolResult`. No invocation is left unanswered,
// and none is answered `completed` without being adjudicated.
// - The approval seam is asked to EVALUATE; only an ask outcome mints an approval request, so a
//   call the person's own policy already settled never prompts them.
// - Fail closed without a seam: at spawn the registry is withheld from the provider, and a stray
//   runtime invocation (a provider that registered tools on an earlier connection) is answered
//   `denied` plus a `DriverDiagnosticRecord`. Both refusals are recorded.
// - An unknown tool name or schema-invalid arguments answer `failed` before any Cedar round-trip,
//   so malformed provider output never reaches the approval pipeline.

import {
  DRIVER_TOOL_NAME_MAX_LEN,
  type RunId,
  type SessionCallbackTool,
} from "@ai-sidekicks/contracts/provider-driver";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import type { DriverDiagnosticsEmitter } from "./driver-diagnostics.js";
import {
  DRIVER_TOOL_CALL_ID_MAX_LEN,
  type CallbackToolInvocation,
  type CallbackToolResult,
} from "./provider-driver.js";

/**
 * One evaluation input, shaped as the `approval.requestCreate` payload the composed `check()`
 * consumes; `arguments` rides along because a policy may condition on the call's own parameters.
 */
export interface CallbackToolApprovalRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * The settled adjudication; `basis` records how it was reached, and only a `user-*` basis minted an
 * approval request. There is no `ask` arm: the approval pipeline owns pending state and stores it.
 */
export type CallbackToolApprovalOutcome =
  | {
      readonly decision: "allow";
      readonly basis: "policy" | "remembered-rule" | "user-grant";
    }
  | {
      readonly decision: "deny";
      readonly basis: "policy" | "remembered-rule" | "user-refusal";
      readonly reason: string;
    };

/** The port the composed `check()` satisfies; the daemon composition root binds the two. */
export interface CallbackToolApprovalSeam {
  evaluate(request: CallbackToolApprovalRequest): Promise<CallbackToolApprovalOutcome>;
}

/**
 * Runs one ADJUDICATED invocation. Reached only after an `allow`, so an executor never re-checks
 * authorization.
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
 * One settled invocation, as the event pipeline records it. Producer-only: the consumer builds the
 * event envelope, so no driver-adjacent module composes a `session_events` row.
 */
export interface CallbackToolActivityRecord {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly toolName: string;
  /** Copied verbatim: tool-event pairing is an exact-string match. */
  readonly toolCallId: string;
  readonly disposition: CallbackToolActivityDisposition;
  /** The adjudication basis, or `null` where the invocation was refused before adjudication. */
  readonly approvalBasis: CallbackToolApprovalOutcome["basis"] | null;
}

/** Lands one settled invocation as an ordinary `tool_activity` row. */
export interface CallbackToolActivitySink {
  record(record: CallbackToolActivityRecord): void;
}

/** Why a spawn withheld the callback-tool registry from the provider. */
export type CallbackToolRegistryWithholdingReason =
  /** No evaluation seam is registered, so nothing could be adjudicated. */
  | "no-approval-seam"
  /** The provider cannot register the tools at this negotiated posture. */
  | "provider-registration-unavailable";

/**
 * Identifies ONE installation of ONE session's callback-tool registry, so a superseded process's
 * callbacks and teardown cannot act on its replacement. Compared by reference, never by ordinal.
 */
export interface CallbackToolRegistryToken {
  /** Daemon-local installation ordinal, for diagnostics only. */
  readonly installation: number;
}

/**
 * The resolved spawn-time registry: the admitted tools, or a withholding. Both arms carry the token
 * because a withholding still installs an (empty) registry that a later spawn can supersede.
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
   * The installation this one displaced, for rollback. Depth is one: an older one was displaced
   * by a spawn that succeeded, and restoring it would revive a registry whose process is gone.
   */
  readonly superseded: InstalledCallbackToolRegistry | undefined;
}

/** Construction inputs for {@link CallbackToolHost}. */
export interface CallbackToolHostOptions {
  readonly provider: ProviderName;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly executor: CallbackToolExecutor;
  readonly activitySink: CallbackToolActivitySink;
  /** Optional: without it the registry is withheld at spawn and a stray invocation is denied. */
  readonly approvalSeam?: CallbackToolApprovalSeam | undefined;
}

/**
 * The daemon-side callback-tool dispatcher, built only by the composition root (a driver never
 * constructs or looks one up); it holds the per-session registries the unknown-tool and argument
 * checks read. Per spawn: `resolveSpawnRegistry` first (`dispatch` refuses a session
 * with no registry), then spawn with the token-bound dispatcher, then `forgetSession` or, if the
 * spawn failed, `rollbackSpawnRegistry`. Prefer {@link bindCallbackToolsForSpawn}, which does this.
 */
export class CallbackToolHost {
  readonly #provider: ProviderName;
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
   * Resolves the callback-tool registry a spawn may offer the provider and remembers it for the
   * session's dispatch checks. A withholding is recorded and returned, never thrown: a session
   * without callback tools is degraded, not failed.
   */
  resolveSpawnRegistry(request: {
    readonly sessionId: SessionId;
    readonly requestedTools: readonly SessionCallbackTool[] | undefined;
    readonly providerRegistrationAvailable: boolean;
    readonly providerRegistrationUnavailableDetail: string;
  }): CallbackToolRegistryResolution {
    // Nothing requested is not a withholding, but an empty registry is still installed so a stray
    // invocation is refused as an unknown tool, not as an unseen session.
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

    // Cloned and frozen so a driver widening an `inputSchema` in place cannot move argument
    // admission past the spawn-time decision.
    const admittedTools = requestedTools.map(cloneRegisteredCallbackTool);
    return {
      admitted: true,
      tools: Object.freeze(admittedTools),
      registryToken: this.#installRegistry(request.sessionId, admittedTools),
    };
  }

  /**
   * Forgets one session's registry, scoped to the installation that asked. `null` is an unscoped
   * teardown for daemon-wide shutdown only: from a superseded spawn it is the bug the token closes.
   * Idempotent.
   */
  forgetSession(sessionId: SessionId, registryToken: CallbackToolRegistryToken | null): void {
    const installed = this.#registriesBySessionId.get(sessionId);
    if (installed === undefined) {
      return;
    }
    if (registryToken !== null && installed.token !== registryToken) {
      // Honoring it would tear down the live registry; dropping it unrecorded would hide that the
      // teardown did nothing.
      this.#recordReleaseIgnored(sessionId, registryToken, installed.token);
      return;
    }
    this.#registriesBySessionId.delete(sessionId);
  }

  /**
   * Installs one session's registry and mints its token. A replacement (resume or relaunch) is
   * recorded because it is when the superseded spawn's dispatcher and teardown stop acting.
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
      // Stripped of its own predecessor so the chain stays one deep.
      superseded:
        superseded === undefined
          ? undefined
          : { token: superseded.token, toolsByName: superseded.toolsByName, superseded: undefined },
    });
    if (superseded !== undefined) {
      this.#recordRegistryReplacement(
        sessionId,
        "a second spawn installed a callback-tool registry for a session that still had one " +
          "installed; the superseded installation no longer dispatches or releases",
        superseded.token,
        token,
        toolsByName.size,
      );
    }
    return token;
  }

  /**
   * Undoes one installation, restoring the registry it displaced: a failed spawn has already
   * superseded a predecessor that may still be alive (a driver may keep its prior connection live).
   * Scoped like {@link forgetSession}; with nothing displaced it is a release. Idempotent.
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
    // Recorded like an install, so the person's view of the live installation stays current.
    this.#recordRegistryReplacement(
      sessionId,
      "a failed spawn rolled its callback-tool registry back; the installation it had " +
        "superseded is live again and the failed one no longer dispatches or releases",
      registryToken,
      predecessor.token,
      predecessor.toolsByName.size,
    );
  }

  /** One registry displacing another: an install, or a rollback's restore. */
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
        "a superseded spawn's teardown ran after its callback-tool registry had been " +
        "replaced; leaving the live installation in place",
      details: {
        sessionId,
        releasingInstallation: releasingToken.installation,
        installedInstallation: installedToken.installation,
      },
    });
  }

  /**
   * Records one provider ask the driver could not turn into a `CallbackToolInvocation`, so it never
   * reached {@link dispatch}. It reuses `callback_tool_invocation_refused` and writes no
   * `tool_activity` row: the record needs a `RunId` and `toolCallId` an unformed ask may lack.
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
        // Untrusted provider output, bounded because this payload often failed the schema; an
        // unbounded copy would put a provider-sized string into the emitter's 256-record ring.
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
   * Dispatches one invocation and answers it; the driver binds this as `onCallbackToolCall`.
   * Order is the contract: availability, registry resolution, argument validation, adjudication,
   * then execution. `registryToken` scopes the call to one installation; `null` is unscoped, for a
   * per-driver routed-ask responder that outlives any one spawn and holds no token.
   */
  async dispatch(
    invocation: CallbackToolInvocation,
    registryToken: CallbackToolRegistryToken | null,
  ): Promise<CallbackToolResult> {
    const approvalSeam = this.#approvalSeam;
    if (approvalSeam === undefined) {
      // Runtime backstop for a provider carrying a registration this daemon did not perform.
      // Checked first and `denied`, not `failed`: later it would be unreachable (a withholding
      // installs an empty registry), and `failed` would blame the provider.
      return this.#refuseInvocation(
        invocation,
        "denied",
        "denied-no-seam",
        "callback_tool_seam_absent",
        "no approval evaluation seam is registered; refusing rather than completing without " +
          "adjudication",
      );
    }

    const installed = this.#registriesBySessionId.get(invocation.sessionId);
    if (installed !== undefined && registryToken !== null && installed.token !== registryToken) {
      // Ahead of the tool lookup: a superseded spawn's late callback is refused for whose registry
      // it belongs to, not admitted because the replacement registers a same-named tool.
      return this.#refuseInvocation(
        invocation,
        "failed",
        "failed-superseded-binding",
        "callback_tool_invocation_refused",
        "invocation was raised against a callback-tool registry a later spawn has " +
          "superseded; refusing rather than adjudicating it against the live spawn's registry",
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

    // A throwing seam did not adjudicate, so it is refused like an absent seam (reusing that kind);
    // letting the rejection escape would leave the invocation unanswered and hang the turn.
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
        `the approval evaluation seam threw before adjudicating; refusing rather than ` +
          `completing without adjudication (${describeExecutorFailure(cause)})`,
      );
    }
    if (outcome.decision === "deny") {
      this.#recordActivity(invocation, "denied-by-policy", outcome.basis);
      return { status: "denied", error: outcome.reason };
    }

    // An execution failure is the tool's outcome, not the pipeline's: it lands as an allowed row
    // that failed. A throwing executor is normalized so the invocation is never left unanswered.
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
    // Installed empty, not absent: an absent registry would make a stray invocation look like one
    // naming a session this host never spawned.
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
        // Untrusted provider output, carried as data. Bounded because `dispatch` is public, so the
        // schema's bound is not this method's precondition.
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
    // Contained: the invocation's answer is the guarantee, and the row is observability, so a
    // throwing sink must not turn a settled invocation into an unanswered one. The failure goes
    // to the diagnostic channel instead.
    try {
      this.#activitySink.record({
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        toolName: invocation.toolName,
        toolCallId: invocation.toolCallId,
        disposition,
        approvalBasis,
      });
    } catch (recordFailure) {
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "callback_tool_activity_record_failed",
        rawWireType: null,
        dispositionReason: `the activity sink threw: ${String(recordFailure)}`,
        details: {
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          disposition,
          ...describeBoundedWireIdentifier(
            "toolName",
            invocation.toolName,
            DRIVER_TOOL_NAME_MAX_LEN,
          ),
          ...describeBoundedWireIdentifier(
            "toolCallId",
            invocation.toolCallId,
            DRIVER_TOOL_CALL_ID_MAX_LEN,
          ),
        },
      });
    }
  }
}

/**
 * Describes why an invocation's arguments are refused, or `null` to admit them. Deliberately not a
 * JSON Schema validator: it checks only that an object-typed tool gets an object with its declared
 * `required` properties, and leaves everything else to the tool.
 */
export function describeArgumentRefusal(
  tool: SessionCallbackTool,
  invocationArguments: Readonly<Record<string, unknown>>,
): string | null {
  const declaredType = tool.inputSchema["type"];
  if (declaredType !== undefined && declaredType !== "object") {
    // The contract's `Record<string, unknown>` arguments cannot satisfy a non-object schema, so
    // such a tool is uninvocable through this path by construction.
    return (
      `registered callback tool declares a non-object input schema (${String(declaredType)}), ` +
      `which this invocation shape cannot satisfy`
    );
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
  return (
    `invocation omits required argument(s) declared by the registered input schema: ` +
    `${missingProperties.join(", ")}`
  );
}

/**
 * Describes one untrusted provider identifier as bounded diagnostic detail, since both call sites
 * can receive payloads the schema did not admit. Truncation sets `<field>Truncated` plus the
 * original length; a `null` value carries no flag ("no name sent" versus "a short name sent").
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
 * Cuts a string to at most `maxLength` UTF-16 code units without splitting a surrogate pair, which
 * some sinks cannot serialize.
 */
function truncateAtCodePointBoundary(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return splitsSurrogatePair ? cut.slice(0, -1) : cut;
}

/**
 * Copies one registry descriptor so the host validates against a value no caller can mutate. Only
 * `inputSchema` and its `required` are copied deep: nothing deeper is read, and a structured clone
 * would throw on non-cloneable values.
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

/** Normalizes an executor throw into a detail string. */
function describeExecutorFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return "The callback-tool executor failed with no describable detail.";
}

/**
 * One spawn's callback-tool wiring: what to offer the provider, its dispatcher, and how to let the
 * session go. Holding it means resolution is done and the dispatcher cannot be bound without its
 * products; a failed spawn must call `rollback`, a torn-down one `release`.
 */
export interface CallbackToolSpawnBinding {
  /** The resolution, so a caller can report a withholding. */
  readonly resolution: CallbackToolRegistryResolution;
  /**
   * The value for `CreateSessionParams.callbackTools`: a fresh mutable array, so a driver's
   * mutation cannot reach the host's answer. The descriptors are the host's frozen clones.
   */
  readonly callbackTools: SessionCallbackTool[];
  /**
   * The value for `CreateSessionParams.onCallbackToolCall`. Bound even on a withholding, so a stray
   * invocation becomes a recorded refusal instead of an unanswered frame.
   */
  readonly onCallbackToolCall: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>;
  /** Teardown on the success path. Idempotent and scoped to this spawn's installation. */
  readonly release: () => void;
  /**
   * Teardown when the spawn never established: restores the registry it displaced, which a driver
   * may deliberately still be using. Equals `release()` when nothing was displaced.
   */
  readonly rollback: () => void;
}

/**
 * Resolves the registry and composes the release and rollback teardowns into one
 * {@link CallbackToolSpawnBinding}. A free function because it is the composition root's operation.
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

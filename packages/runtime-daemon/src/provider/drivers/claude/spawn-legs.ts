// What a Claude process is spawned under: the spawn-bound legs every spawn path realizes, the
// binding a later run is checked against, and the check itself.

import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import {
  type ClaudeSessionTransport,
  type ClaudeSpawnBoundLegs,
  composeClaudeMandatedEnvironment,
} from "./session-transport.js";
import type {
  ClaudeSessionLifecycleDependencies,
  ClaudeSpawnBinding,
  LiveClaudeSession,
} from "./session-state.js";
import { ClaudeSessionUnavailableError } from "./session-errors.js";
import {
  type ClaudeSubagentAdmissionPort,
  ClaudeSubagentConcurrencyGate,
  realizeClaudeSubagentPolicy,
} from "./subagent-policy.js";
import {
  CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
  type ClaudeCallbackMcpServerDescriptor,
  composeClaudeCallbackMcpServer,
  composeClaudeSandboxSettings,
} from "./spawn-settings.js";
import { digestOutputSchema, findPostureDivergence } from "./session-posture.js";
import type {
  CreateSessionParams,
  ResumeSessionParams,
  StartRunParams,
  SubagentPolicy,
} from "../../provider-driver.js";

/**
 * Composes the spawn-bound legs of a create or resume and the subagent gate of every spawn,
 * recording each withheld definition or callback-tool registry as a diagnostic.
 */
export class ClaudeSpawnLegComposer {
  readonly #transport: ClaudeSessionTransport;
  readonly #diagnostics: DriverDiagnosticsEmitter;

  constructor(dependencies: Pick<ClaudeSessionLifecycleDependencies, "transport" | "diagnostics">) {
    this.#transport = dependencies.transport;
    this.#diagnostics = dependencies.diagnostics;
  }

  /** The ONE builder both spawn paths use — see `ClaudeSpawnBoundLegs`. */
  buildSpawnBoundLegs(params: CreateSessionParams | ResumeSessionParams): ClaudeSpawnBoundLegs {
    const subagentPolicy = params.subagentPolicy;
    const realizedSubagents =
      subagentPolicy === undefined ? undefined : realizeClaudeSubagentPolicy(subagentPolicy);
    for (const withheldDefinition of realizedSubagents?.withheld ?? []) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "subagent_definition_disabled",
        rawWireType: null,
        dispositionReason: withheldDefinition.reason,
        // Untrusted caller text, carried as data so the person can see which definition was
        // withheld.
        details: { sessionId: params.sessionId, definitionName: withheldDefinition.name },
      });
    }
    const posture = params.executionPosture;
    const callbackToolServer = this.#resolveCallbackToolServer(params);
    return {
      sessionId: params.sessionId,
      model: params.model,
      executionPosture: posture,
      sandboxSettings: posture === undefined ? undefined : composeClaudeSandboxSettings(posture),
      // The registry offered is the one the descriptor serves, so a withholding sheds both.
      callbackTools: callbackToolServer === undefined ? undefined : [...callbackToolServer.tools],
      callbackToolServer,
      subagentPolicy: realizedSubagents?.policy,
      withheldSubagentDefinitions: realizedSubagents?.withheld ?? [],
      subagentAdmission: this.buildSubagentAdmission(params.sessionId, realizedSubagents?.policy),
      outputSchema: params.outputSchema,
      onCallbackToolCall: params.onCallbackToolCall,
      onMcpServerStatus: params.onMcpServerStatus,
      // The shared composer, so this path and the auth probe cannot hold different opt-outs.
      mandatedEnvironment: composeClaudeMandatedEnvironment(),
    };
  }

  /**
   * Serves a callback-tool registry only when a dispatcher is bound to answer it: a withheld
   * registry costs the model no turns, unlike one served and then refused. Whether the model sees
   * it at all is the transport's declaration (`realizesCallbackToolRegistration`).
   */
  #resolveCallbackToolServer(
    params: CreateSessionParams | ResumeSessionParams,
  ): ClaudeCallbackMcpServerDescriptor | undefined {
    const requestedTools = params.callbackTools ?? [];
    if (requestedTools.length === 0) {
      return undefined;
    }
    // The driver cannot tell a host with no approval seam from an unbound dispatcher.
    if (params.onCallbackToolCall === undefined) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "callback_tool_registry_withheld",
        rawWireType: null,
        dispositionReason:
          "no callback-tool dispatcher is bound for this spawn, so no invocation could be " +
          "answered; the registry is withheld rather than offered unanswerable",
        details: {
          sessionId: params.sessionId,
          reason: "no-dispatcher-bound",
          withheldToolCount: requestedTools.length,
        },
      });
      return undefined;
    }
    if (!this.#transport.realizesCallbackToolRegistration) {
      this.#diagnostics.emit({
        provider: "claude",
        kind: "callback_tool_registry_withheld",
        rawWireType: null,
        dispositionReason: CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
        details: {
          sessionId: params.sessionId,
          reason: "transport-registration-unavailable",
          withheldToolCount: requestedTools.length,
        },
      });
      return undefined;
    }
    return composeClaudeCallbackMcpServer(requestedTools);
  }

  // One gate per spawn, not per session: a relaunch's subagents are new, and old slots would hold a
  // cap against calls that died with the old process.
  buildSubagentAdmission(
    sessionId: SessionId,
    policy: SubagentPolicy | undefined,
  ): ClaudeSubagentAdmissionPort | undefined {
    if (policy === undefined || !policy.enabled) {
      return undefined;
    }
    return new ClaudeSubagentConcurrencyGate({
      sessionId,
      diagnostics: this.#diagnostics,
      maxConcurrent: policy.maxConcurrent,
    });
  }
}

/** The posture and output-schema digest a session is spawned under, which later runs must match. */
export function buildClaudeSpawnBinding(
  params: CreateSessionParams | ResumeSessionParams,
): ClaudeSpawnBinding {
  const outputSchema = params.outputSchema;
  return {
    executionPosture: params.executionPosture,
    outputSchemaDigest: outputSchema === undefined ? undefined : digestOutputSchema(outputSchema),
  };
}

/**
 * Refuses a run admitted against a different realization than the session's spawn: Claude binds
 * posture and output schema at spawn, and the session-boundary relaunch it would need is the
 * daemon's decision. Each check is keyed on what the run declares; declaring nothing on an axis
 * leaves it free. Throws `ClaudeSessionUnavailableError`.
 */
export function assertClaudeSpawnBoundRealization(
  params: StartRunParams,
  live: LiveClaudeSession,
): void {
  const runPosture = params.executionPosture;
  if (runPosture !== undefined) {
    const spawnPosture = live.spawnBinding.executionPosture;
    if (spawnPosture === undefined) {
      throw new ClaudeSessionUnavailableError("execution_posture_mismatch", {
        sessionId: live.sessionId,
        runId: params.runId,
        detail:
          `The run declares execution posture ${runPosture.mode}, but the Claude session was ` +
          `spawned with none.`,
      });
    }
    const divergentAxis = findPostureDivergence(runPosture, spawnPosture);
    if (divergentAxis !== undefined) {
      throw new ClaudeSessionUnavailableError("execution_posture_mismatch", {
        sessionId: live.sessionId,
        runId: params.runId,
        detail: `Execution posture diverges on ${divergentAxis}.`,
      });
    }
  }

  const runOutputSchema = params.outputSchema;
  if (runOutputSchema !== undefined) {
    const spawnOutputSchemaDigest = live.spawnBinding.outputSchemaDigest;
    if (spawnOutputSchemaDigest === undefined) {
      throw new ClaudeSessionUnavailableError("output_schema_unbound", {
        sessionId: live.sessionId,
        runId: params.runId,
      });
    }
    const runOutputSchemaDigest = digestOutputSchema(runOutputSchema);
    if (runOutputSchemaDigest !== spawnOutputSchemaDigest) {
      throw new ClaudeSessionUnavailableError("output_schema_mismatch", {
        sessionId: live.sessionId,
        runId: params.runId,
        detail:
          `Run schema digest ${runOutputSchemaDigest.slice(0, 16)}, session schema digest ` +
          `${spawnOutputSchemaDigest.slice(0, 16)}.`,
      });
    }
  }
}

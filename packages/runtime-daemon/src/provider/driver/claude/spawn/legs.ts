// What a Claude process is spawned under: the spawn-bound legs every spawn path realizes, the
// binding a later run is checked against, and the check itself.

import { CURATED_CREDENTIAL_POLICY_REF } from "../../../../policy/execution-posture-service.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { ClaudeSessionTransport, ClaudeSpawnBoundLegs } from "../session/transport.js";
import type {
  ClaudeSessionLifecycleDependencies,
  ClaudeSpawnBinding,
  LiveClaudeSession,
} from "../session/state.js";
import { ClaudeSessionUnavailableError } from "../session/errors.js";
import {
  CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
  type ClaudeCallbackMcpServerDescriptor,
  composeClaudeCallbackMcpServer,
} from "./settings.js";
import { writeClaudeHomeRetention } from "./account-home.js";
import { composeClaudeSpawnEnvironment } from "./environment.js";
import { digestOutputSchema, findPostureDivergence } from "../session/posture.js";
import type { CreateSessionParams, ResumeSessionParams, StartRunParams } from "../../contract.js";

/**
 * Composes the spawn-bound legs of a create or resume: where and as whom the process runs, its
 * whole environment, the credential paths it is denied, and the tools it is offered, recording a
 * withheld callback-tool registry as a diagnostic.
 */
export class ClaudeSpawnLegComposer {
  readonly #transport: ClaudeSessionTransport;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #providerBaseEnvironment: readonly SpawnEnvPair[];
  readonly #operatingSystem: ClaudeSessionLifecycleDependencies["operatingSystem"];
  readonly #spawnContext: ClaudeSessionLifecycleDependencies["spawnContext"];
  readonly #credentialPolicy: ClaudeSessionLifecycleDependencies["credentialPolicy"];

  constructor(
    dependencies: Pick<
      ClaudeSessionLifecycleDependencies,
      | "transport"
      | "diagnostics"
      | "providerBaseEnvironment"
      | "operatingSystem"
      | "spawnContext"
      | "credentialPolicy"
    >,
  ) {
    this.#transport = dependencies.transport;
    this.#diagnostics = dependencies.diagnostics;
    this.#providerBaseEnvironment = dependencies.providerBaseEnvironment;
    this.#operatingSystem = dependencies.operatingSystem;
    this.#spawnContext = dependencies.spawnContext;
    this.#credentialPolicy = dependencies.credentialPolicy;
  }

  /**
   * The ONE builder every spawn path uses — see `ClaudeSpawnBoundLegs`. Throws when the spawn
   * context or the credential list cannot be resolved, or the environment cannot be built.
   */
  async buildSpawnBoundLegs(
    params: CreateSessionParams | ResumeSessionParams,
  ): Promise<ClaudeSpawnBoundLegs> {
    const posture = params.executionPosture;
    const context = await this.#spawnContext.resolveSpawnContext(
      params.sessionId,
      params.providerAccountId,
    );
    // Every spawn on a home the app manages keeps the home's own retention set; the person's own
    // home is theirs.
    if (context.accountFolders !== undefined) {
      await writeClaudeHomeRetention(context.accountFolders.configFolder);
    }
    // The curated list is handed over on every level, a posture-less spawn included.
    const credentialPolicy = await this.#credentialPolicy.resolveCredentialPolicy(
      posture?.credentialPolicyRef ?? CURATED_CREDENTIAL_POLICY_REF,
    );
    const callbackToolServer = this.#resolveCallbackToolServer(params);
    return {
      sessionId: params.sessionId,
      model: params.model,
      executionPosture: posture,
      workingDirectory: context.workingDirectory,
      // The registry offered is the one the descriptor serves, so a withholding sheds both.
      callbackTools: callbackToolServer === undefined ? undefined : [...callbackToolServer.tools],
      callbackToolServer,
      subagentPolicy: params.subagentPolicy,
      toolServers: params.toolServers ?? [],
      outputSchema: params.outputSchema,
      onCallbackToolCall: params.onCallbackToolCall,
      onMcpServerStatus: params.onMcpServerStatus,
      credentialDenyPaths: credentialPolicy.denyPaths,
      memoryFolders: context.memoryFolders,
      advisorModel: context.advisorModel,
      outputStyle: context.outputStyle,
      spawnEnvironment: composeClaudeSpawnEnvironment({
        providerBaseEnvironment: this.#providerBaseEnvironment,
        environmentNameMatch: this.#operatingSystem.environmentNameMatch,
        environmentRows: context.environmentRows,
        accountFolders: context.accountFolders,
      }),
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

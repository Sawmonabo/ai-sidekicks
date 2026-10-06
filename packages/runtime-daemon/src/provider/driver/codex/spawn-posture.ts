// The Codex leg's spawn and turn posture: the spawn config and credential policy a create or resume
// launches under, the posture and subagent legs a thread is established with, the per-turn sandbox
// policy, and the diagnostics for what this provider cannot realize.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { CredentialEnvPolicy } from "../../spawn-env.js";
import type { CodexLifecycleOptions, CodexSessionRecord } from "./session/state.js";
import {
  CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
  type CodexSessionConfig,
  composeCodexSubagentConfigOverrides,
  composeCodexThreadPosture,
  composeCodexTurnSandboxPolicy,
  findCodexSandboxModeDivergence,
  parseCodexSessionConfig,
  resolveBoundProviderAccountId,
} from "./session/config.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { CodexDriverConfigError, CodexTransportError } from "./session/errors.js";
import { reportDiagnosticFromDetachedFrame } from "./transport/diagnostics.js";
import { CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL } from "./server-requests.js";
import type {
  CreateSessionParams,
  ResumeSessionParams,
  StartRunParams,
  SubagentPolicy,
} from "../provider-driver.js";

/** Composes what a Codex spawn, thread and turn are established under, and reports the gaps. */
export class CodexSpawnPosture {
  readonly #options: Pick<
    CodexLifecycleOptions,
    "resumeSpawnConfig" | "resolveCredentialEnvPolicy" | "reportDiagnostic" | "diagnostics"
  >;

  constructor(
    options: Pick<
      CodexLifecycleOptions,
      "resumeSpawnConfig" | "resolveCredentialEnvPolicy" | "reportDiagnostic" | "diagnostics"
    >,
  ) {
    this.#options = options;
  }

  /**
   * `cwd` and `env` come from the untyped `params.config`, parsed fail-closed on every create; the
   * credential policy is posture-derived. Members are built one by one, never spread, so a policy
   * the posture resolved away is not carried through.
   */
  async composeCreateSpawnConfig(params: CreateSessionParams): Promise<CodexSessionConfig> {
    const declared = parseCodexSessionConfig(params.config);
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      declared.credentialEnvPolicy,
      params.executionPosture,
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // The typed and config channels can both name the credential home; the typed one is checked
    // against the other, so a typed caller cannot silently spawn against the node default.
    const providerAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "CreateSessionParams.providerAccountId",
      recorded: declared.providerAccountId,
      recordedField: "CreateSessionParams.config.providerAccountId",
    });
    return {
      cwd: declared.cwd,
      env: declared.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * `cwd` and `env` come from the live record's spawn config, else the manager default; the
   * credential policy is entirely posture-derived, since inheriting it would relaunch a session
   * under a policy its new posture did not name. Members are built one by one, never spread.
   */
  async composeResumeSpawnConfig(
    existing: CodexSessionRecord | undefined,
    params: ResumeSessionParams,
  ): Promise<CodexSessionConfig> {
    const processContext = existing?.spawnConfig ?? this.#options.resumeSpawnConfig;
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      processContext.credentialEnvPolicy,
      params.executionPosture,
      "ResumeSessionParams.executionPosture.credentialPolicyRef",
    );
    // Re-derived so a posture change reaches the child. The account is pinned for the leg's
    // lifetime, so a typed member contradicting the live record refuses.
    const requestedAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "ResumeSessionParams.providerAccountId",
      recorded: existing?.spawnConfig.providerAccountId,
      recordedField: "the live session record's own spawn config",
    });
    // A mismatch (an unbound environment account counts) refuses: this driver is handed a built
    // credential environment and cannot build another account's. Rebinding to the admitted account
    // happens above this seam, which supplies a resume spawn config built for it.
    const environmentAccountId = processContext.providerAccountId;
    if (requestedAccountId !== undefined && requestedAccountId !== environmentAccountId) {
      const environmentSource =
        existing === undefined
          ? `no live session record survives, so the only environment available is the ` +
            `node-wide default's, constructed for ${environmentAccountId ?? "no bound account"}`
          : `the live session record this resume relaunches from was established for ` +
            `${environmentAccountId ?? "no bound account"}, so its environment is not that ` +
            `account's`;
      throw new CodexDriverConfigError(
        `ResumeSessionParams.providerAccountId names provider account ${requestedAccountId}, ` +
          `but ${environmentSource}; this driver is handed a constructed credential ` +
          `environment and cannot build another account's, so the relaunch is refused rather ` +
          `than spawned against an environment that bills elsewhere.`,
        "ResumeSessionParams.providerAccountId",
      );
    }
    const providerAccountId = environmentAccountId;
    return {
      cwd: processContext.cwd,
      env: processContext.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * Answers which credential policy filters a spawned child; create and resume both call it, and a
   * new spawn path must too. No posture keeps the declared policy; a posture's reference is
   * resolved on every permission level, and an unresolved one is refused rather than degraded to
   * "deny nothing".
   */
  async #resolveCredentialEnvPolicyForPosture(
    declaredPolicy: CredentialEnvPolicy | undefined,
    posture: ExecutionPosture | undefined,
    postureRefusalField: string,
  ): Promise<CredentialEnvPolicy | undefined> {
    if (posture === undefined) {
      return declaredPolicy;
    }
    const resolved = await this.#options.resolveCredentialEnvPolicy(posture);
    if (resolved === undefined) {
      throw new CodexDriverConfigError(
        `The execution posture "${posture.mode}" carries a credential policy reference that ` +
          `resolved to no policy, so the spawned child cannot be filtered.`,
        postureRefusalField,
      );
    }
    return resolved;
  }

  /**
   * The thread-establishment legs one posture and one subagent policy realize: the posture's
   * `sandbox` and `approvalPolicy`, and the subagent caps as `config` overrides. Used by
   * `thread/start`, `thread/resume` and `thread/fork`.
   */
  composeThreadEstablishmentLegs(
    posture: ExecutionPosture | undefined,
    subagentPolicy: SubagentPolicy | undefined,
  ): Record<string, unknown> {
    this.#reportWithheldSubagentDefinitions(subagentPolicy);
    return {
      ...this.#composeSpawnPostureParams(posture),
      ...(subagentPolicy === undefined
        ? {}
        : { config: composeCodexSubagentConfigOverrides(subagentPolicy) }),
    };
  }

  /**
   * The spawn-time posture legs (`sandbox`, `approvalPolicy`). The credential deny-list is realized
   * in the child environment, so no credential axis is read here.
   */
  #composeSpawnPostureParams(posture: ExecutionPosture | undefined): Record<string, unknown> {
    if (posture === undefined) {
      return {};
    }
    const { sandbox, approvalPolicy } = composeCodexThreadPosture(posture);
    return { sandbox, approvalPolicy };
  }

  /**
   * Refuses a run that declares a posture on a session established with none, or whose posture maps
   * to another Codex sandbox mode than the session's: the person's own network setting is known
   * only for the thread's own sandbox, and moving a conversation's level is a thread-level change,
   * not a turn override. Throws `CodexTransportError`.
   */
  assertRunSandboxModeMatchesSession(record: CodexSessionRecord, params: StartRunParams): void {
    const runPosture = params.executionPosture;
    if (runPosture === undefined) {
      return;
    }
    const sessionPosture = record.executionPosture;
    if (sessionPosture === undefined) {
      throw new CodexTransportError(
        `The run declares execution posture ${runPosture.mode}, but session "` +
          `${record.sessionId}" was established with none.`,
        {
          sessionId: record.sessionId,
          runId: params.runId,
          reason: "execution_posture_mismatch",
        },
      );
    }
    const divergence = findCodexSandboxModeDivergence(runPosture, sessionPosture);
    if (divergence !== undefined) {
      throw new CodexTransportError(
        `The run's execution posture ${runPosture.mode} runs Codex in the ${divergence.run} ` +
          `sandbox, but session "${record.sessionId}" was established at ${sessionPosture.mode}` +
          ` in the ${divergence.session} sandbox.`,
        {
          sessionId: record.sessionId,
          runId: params.runId,
          reason: "execution_posture_mismatch",
        },
      );
    }
  }

  /**
   * The turn's `sandboxPolicy`, from the run's posture or else the session's, so a turn never goes
   * out with no policy; empty when neither declares one. Network access follows the thread's own.
   */
  composeTurnPostureParams(
    record: CodexSessionRecord,
    params: StartRunParams,
  ): Record<string, unknown> {
    const posture = params.executionPosture ?? record.executionPosture;
    if (posture === undefined) {
      return {};
    }
    return {
      sandboxPolicy: composeCodexTurnSandboxPolicy(posture, record.providerNetworkAccess),
    };
  }

  /**
   * Records every subagent definition this spawn withheld. The concurrency caps are still sent
   * (the half the provider enforces natively) by `composeCodexSubagentConfigOverrides`.
   */
  #reportWithheldSubagentDefinitions(policy: SubagentPolicy | undefined): void {
    if (policy === undefined || !policy.enabled) {
      return;
    }
    for (const definition of policy.definitions) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "subagent-definition-withheld",
        definitionName: definition.name,
        reason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
      });
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "subagent_definition_disabled",
        rawWireType: null,
        dispositionReason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
        // Untrusted caller-supplied text, carried verbatim as data.
        details: { definitionName: definition.name },
      });
    }
  }

  /**
   * Records that a spawn offered the provider no callback-tool registry; the session is degraded,
   * not failed.
   */
  reportWithheldCallbackTools(
    sessionId: SessionId,
    callbackTools: readonly unknown[] | undefined,
  ): void {
    const withheldToolCount = callbackTools?.length ?? 0;
    if (withheldToolCount === 0) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "callback-tools-withheld",
      withheldToolCount,
      reason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
    });
    // Both sinks: the local transport arm is this driver's structured record; the shared
    // diagnostic kind is the one the daemon's counters name.
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "callback_tool_registry_withheld",
      rawWireType: null,
      dispositionReason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
      details: {
        sessionId,
        reason: "provider-registration-unavailable",
        withheldToolCount,
      },
    });
  }
}

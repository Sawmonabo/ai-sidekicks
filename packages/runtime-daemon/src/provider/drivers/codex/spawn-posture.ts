// The Codex leg's spawn and turn posture: the spawn config and credential policy a create or resume
// launches under, the posture and subagent legs a thread is established with, the per-turn sandbox
// policy, and the diagnostics for what this provider cannot realize.

import type {
  CreateSessionParams,
  ExecutionPosture,
  ResumeSessionParams,
  SessionId,
  StartRunParams,
  SubagentPolicy,
} from "@ai-sidekicks/contracts";
import type { CredentialEnvPolicy } from "../../spawn-env.js";
import type { CodexLifecycleOptions, CodexSessionRecord } from "./session-state.js";
import {
  CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
  type CodexSessionConfig,
  composeCodexSubagentConfigOverrides,
  composeCodexThreadPosture,
  composeCodexThreadPostureConfig,
  composeCodexTurnSandboxPolicy,
  describeCodexPostureDivergence,
  parseCodexSessionConfig,
  resolveBoundProviderAccountId,
} from "./session-config.js";
import { CodexDriverConfigError } from "./session-errors.js";
import { reportDiagnosticFromDetachedFrame } from "./transport-diagnostics.js";
import { CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL } from "./server-requests.js";
import { isPlainObject } from "./record-readers.js";

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
   * created `trusted` and resumed sandboxed unfiltered. Members are built one by one, never spread.
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
          ? `no live session record survives, so the only environment available is the node-wide default's, constructed for ${environmentAccountId ?? "no bound account"}`
          : `the live session record this resume relaunches from was established for ${environmentAccountId ?? "no bound account"}, so its environment is not that account's`;
      throw new CodexDriverConfigError(
        `ResumeSessionParams.providerAccountId names provider account ${requestedAccountId}, but ${environmentSource}; this driver is handed a constructed credential environment and cannot build another account's, so the relaunch is refused rather than spawned against an environment that bills elsewhere.`,
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
   * new spawn path must too. No posture keeps the declared policy, `trusted` drops it, and an
   * unresolved sandboxed reference is refused rather than degraded to "deny nothing".
   */
  async #resolveCredentialEnvPolicyForPosture(
    declaredPolicy: CredentialEnvPolicy | undefined,
    posture: ExecutionPosture | undefined,
    postureRefusalField: string,
  ): Promise<CredentialEnvPolicy | undefined> {
    if (posture === undefined) {
      return declaredPolicy;
    }
    if (posture.mode === "trusted") {
      return undefined;
    }
    const resolved = await this.#options.resolveCredentialEnvPolicy(posture);
    if (resolved === undefined) {
      throw new CodexDriverConfigError(
        `The execution posture "${posture.mode}" carries a credential policy reference that resolved to no policy, so the spawned child cannot be filtered.`,
        postureRefusalField,
      );
    }
    return resolved;
  }

  /**
   * The thread-establishment legs one posture and one subagent policy realize. Both write the
   * `config` table, so they merge here; used by `thread/start` and `thread/fork`.
   */
  composeThreadEstablishmentLegs(
    posture: ExecutionPosture | undefined,
    subagentPolicy: SubagentPolicy | undefined,
  ): Record<string, unknown> {
    const configOverrides: Record<string, unknown> = {
      ...(posture === undefined ? {} : composeCodexThreadPostureConfig(posture)),
      ...(subagentPolicy === undefined ? {} : composeCodexSubagentConfigOverrides(subagentPolicy)),
    };
    this.#reportWithheldSubagentDefinitions(subagentPolicy);
    return {
      ...this.#composeSpawnPostureParams(posture),
      ...(Object.keys(configOverrides).length === 0 ? {} : { config: configOverrides }),
    };
  }

  /**
   * The spawn-time posture legs (`sandbox`, `approvalPolicy`), plus the diagnostic for the one
   * axis this provider cannot express. Presets are expanded daemon-side, so the profile name is not
   * forwarded; the credential deny-list is realized in the child environment, so no credential
   * axis is read here.
   */
  #composeSpawnPostureParams(posture: ExecutionPosture | undefined): Record<string, unknown> {
    if (posture === undefined) {
      return {};
    }
    this.#reportNarrowedNetworkAllowlist(posture);
    const { sandbox, approvalPolicy } = composeCodexThreadPosture(posture);
    return { sandbox, approvalPolicy };
  }

  /**
   * Compares the realized sandbox against the requested posture and records a divergence; called
   * on every path that establishes a thread.
   */
  assertPostureRealized(posture: ExecutionPosture | undefined, response: unknown): void {
    if (posture === undefined || !isPlainObject(response)) {
      return;
    }
    const divergence = describeCodexPostureDivergence(posture, response["sandbox"]);
    if (divergence === null) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-realization-diverged",
      requestedNetworkAccess: divergence.requestedNetworkAccess,
      realizedNetworkAccess: divergence.realizedNetworkAccess,
    });
  }

  composeTurnPostureParams(
    record: CodexSessionRecord,
    params: StartRunParams,
  ): Record<string, unknown> {
    const posture = params.executionPosture ?? record.executionPosture;
    if (posture === undefined) {
      return {};
    }
    // Reported per turn too: a run adding an allow-list to a session spawned without one would
    // otherwise narrow silently.
    if (params.executionPosture !== undefined) {
      this.#reportNarrowedNetworkAllowlist(params.executionPosture);
    }
    return { sandboxPolicy: composeCodexTurnSandboxPolicy(posture) };
  }

  #reportNarrowedNetworkAllowlist(posture: ExecutionPosture): void {
    if (posture.networkAccess !== "allowed-domains") {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-network-allowlist-narrowed",
      deniedDomainCount: posture.allowedDomains.length,
    });
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
        provider: "codex",
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
    // Both sinks: the local transport arm is this driver's structured record; the censused kind
    // is the one the daemon's counters name.
    this.#options.diagnostics.emit({
      provider: "codex",
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

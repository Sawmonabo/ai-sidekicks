/**
 * Reads the session and run configuration a Codex session is opened with, and turns the execution
 * posture and subagent policy into the thread, turn and config overrides Codex takes.
 */

import { SessionIdSchema, type ExecutionPosture, type SessionId } from "@ai-sidekicks/contracts";
import { type CredentialEnvPolicy, type SpawnEnvNameMatch } from "../../spawn-env.js";
import { type CallerDeclaredFrameOrigin } from "../../outbound-frame.js";
import { CodexDriverConfigError } from "./session-errors.js";
import {
  isPlainObject,
  readOptionalString,
  readRecord,
  readRequiredString,
} from "./record-readers.js";
import type { SubagentPolicy } from "../../provider-driver.js";

/**
 * What this driver requires inside the untyped `CreateSessionParams.config`; `env` is the complete
 * child environment (this module never reads `process.env`).
 */
export interface CodexSessionConfig {
  cwd: string;
  env: ReadonlyArray<readonly [string, string]>;
  /**
   * The provider account this leg's credential home is pinned to; the typed request member wins
   * over this one ({@link resolveBoundProviderAccountId}). Identity and credential environment
   * must never diverge; absence reaches command entries as `null`, which matches nothing.
   */
  providerAccountId?: string | undefined;
  /**
   * The effective credential policy resolved by the daemon, whose denied names are stripped from
   * the child environment; absent under `trusted`. Re-derived from the posture on every create and
   * resume, never inherited from the original launch.
   */
  credentialEnvPolicy?: CredentialEnvPolicy | undefined;
}

/**
 * The origin declared for a run's opening frame: a fact of the code path, not a caller's claim.
 */
export const RUN_OPENING_FRAME_ORIGIN: CallerDeclaredFrameOrigin = "human_text";

/**
 * Posture-affecting `turn/start` fields the daemon derives; `StartRunParams.agentConfig` is
 * untyped, so this refusal keeps a caller-declared policy off the wire.
 */
const CALLER_DERIVED_TURN_POSTURE_FIELDS: readonly string[] = [
  "cwd",
  "sandboxPolicy",
  "permissions",
  "permissionProfile",
  "approvalPolicy",
  "approvalsReviewer",
];

/**
 * Posture members V1 does not realize, asserted absent from every `turn/start`. The provider does
 * not adjudicate `sandboxPolicy` with `permissions` (a default connection refuses `permissions`
 * with `-32600`, an `experimentalApi` one accepts both), so V1 realizes `sandboxPolicy`;
 * `permissionProfile` refuses `-32602` at the pin.
 */
const UNREALIZED_TURN_POSTURE_MEMBERS: readonly string[] = ["permissions", "permissionProfile"];

/**
 * Throws `CodexDriverConfigError` if a constructed `turn/start` carries an unrealized posture
 * member; `#requestTurnStart` is the only construction site.
 */
export function assertRealizedTurnPostureMembers(params: Record<string, unknown>): void {
  for (const member of UNREALIZED_TURN_POSTURE_MEMBERS) {
    if (member in params) {
      throw new CodexDriverConfigError(
        `turn/start must not carry ${member}; V1 realizes the sandboxPolicy member of the posture pair.`,
        `turn/start.${member}`,
      );
    }
  }
}

/**
 * Required contents of `StartRunParams.agentConfig`, which carries the session id and turn text.
 */
export interface CodexRunConfig {
  sessionId: SessionId;
  input: string;
  model?: string | undefined;
  clientUserMessageId?: string | undefined;
}

// Provider keys below come from the pinned build's `v2/` schema and serde field names.

/** Approval supervision for every non-`trusted` posture; `never` is for `trusted` alone. */
const CODEX_SUPERVISED_APPROVAL_POLICY = "on-request" as const;

const CODEX_TRUSTED_APPROVAL_POLICY = "never" as const;

/** Thread-level sandbox selection per posture mode (`SandboxMode` at the pin). */
const CODEX_SANDBOX_MODE_BY_POSTURE_MODE: Readonly<Record<ExecutionPosture["mode"], string>> =
  Object.freeze({
    trusted: "danger-full-access",
    "workspace-sandboxed": "workspace-write",
    "readonly-sandboxed": "read-only",
  });

/**
 * Whether the posture allows network access. A domain allow-list resolves down to `false` (the
 * provider's axis is a boolean) and is reported as a diagnostic.
 */
function codexNetworkAccessEnabled(posture: ExecutionPosture): boolean {
  return posture.networkAccess === "full";
}

/**
 * Config key for the thread-scope network axis (`ThreadStartParams.sandbox` has none); at the pin
 * it moves the realized policy on `workspace-write` only. Snake_case is load-bearing: the config
 * layer silently ignores an unrecognized key.
 */
const CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY = "sandbox_workspace_write.network_access";

/** Thread-level posture: `sandbox` and `approvalPolicy` on `thread/start`. */
interface CodexThreadPostureParams {
  readonly sandbox: string;
  readonly approvalPolicy: string;
}

/** The thread sandbox and approval policy a posture maps to. */
export function composeCodexThreadPosture(posture: ExecutionPosture): CodexThreadPostureParams {
  const sandbox = CODEX_SANDBOX_MODE_BY_POSTURE_MODE[posture.mode];
  return {
    sandbox,
    approvalPolicy:
      posture.mode === "trusted" ? CODEX_TRUSTED_APPROVAL_POLICY : CODEX_SUPERVISED_APPROVAL_POLICY,
  };
}

/** The thread config overrides a posture needs; only a workspace-sandboxed posture sets any. */
export function composeCodexThreadPostureConfig(
  posture: ExecutionPosture,
): Record<string, unknown> {
  if (posture.mode !== "workspace-sandboxed") {
    return {};
  }
  return { [CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY]: codexNetworkAccessEnabled(posture) };
}

/**
 * Compares the sandbox policy the provider says it realized with the posture's; returns the
 * divergence or `null`. Never throws and never fails the spawn.
 */
export function describeCodexPostureDivergence(
  posture: ExecutionPosture,
  realizedSandbox: unknown,
): { readonly requestedNetworkAccess: boolean; readonly realizedNetworkAccess: boolean } | null {
  // Only `workspace-sandboxed` can express its request at thread scope.
  if (posture.mode !== "workspace-sandboxed" || !isPlainObject(realizedSandbox)) {
    return null;
  }
  const realizedNetworkAccess = realizedSandbox["networkAccess"];
  if (typeof realizedNetworkAccess !== "boolean") {
    return null;
  }
  const requestedNetworkAccess = codexNetworkAccessEnabled(posture);
  // Both directions: an ignored unrecognized key leaves network `false`, so a narrower result
  // means the request silently stopped applying.
  if (realizedNetworkAccess !== requestedNetworkAccess) {
    return { requestedNetworkAccess, realizedNetworkAccess };
  }
  return null;
}

/**
 * Per-turn `sandboxPolicy`, sent every turn because it carries the writable roots the thread-level
 * mode cannot; the two exclude flags are pinned `true` so `writableRoots` is the complete list.
 */
export function composeCodexTurnSandboxPolicy(posture: ExecutionPosture): Record<string, unknown> {
  const networkAccess = codexNetworkAccessEnabled(posture);
  switch (posture.mode) {
    case "trusted":
      return { type: "dangerFullAccess" };
    case "readonly-sandboxed":
      return { type: "readOnly", networkAccess };
    case "workspace-sandboxed":
      return {
        type: "workspaceWrite",
        writableRoots: posture.writableRoots,
        networkAccess,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
  }
}

/**
 * The provider's floor on its concurrency cap: `agents.max_concurrent_threads_per_session: 0` is
 * refused at the pin, so zero cannot disable subagents; `agents.max_depth: 0` is accepted and
 * forbids any spawn (a child announces itself at depth 1), so the disable rides on depth.
 */
const CODEX_SUBAGENT_CONCURRENCY_FLOOR = 1;

/** The depth ceiling that admits no child thread at all. */
const CODEX_SUBAGENT_DEPTH_NONE = 0;

/**
 * Normalizes a cap into the provider's `i32`; fractions round down, never below `floor`. The
 * provider rejects a non-integer with a type error that fails the whole spawn.
 */
function normalizeCodexSubagentCap(value: number, floor: number): number {
  if (!Number.isFinite(value)) {
    return floor;
  }
  return Math.max(floor, Math.floor(value));
}

/**
 * The `[agents]` config overrides realizing one subagent policy. A disabled policy, or one below
 * the provider's floor, is sent as a zero depth ceiling: omitting it keeps the installation's
 * defaults and clamping up would grant a subagent.
 */
export function composeCodexSubagentConfigOverrides(
  policy: SubagentPolicy,
): Record<string, unknown> {
  if (!policy.enabled || policy.maxConcurrent < CODEX_SUBAGENT_CONCURRENCY_FLOOR) {
    return {
      "agents.max_concurrent_threads_per_session": CODEX_SUBAGENT_CONCURRENCY_FLOOR,
      "agents.max_depth": CODEX_SUBAGENT_DEPTH_NONE,
    };
  }
  return {
    "agents.max_concurrent_threads_per_session": normalizeCodexSubagentCap(
      policy.maxConcurrent,
      CODEX_SUBAGENT_CONCURRENCY_FLOOR,
    ),
    "agents.max_depth": normalizeCodexSubagentCap(policy.maxDepth, CODEX_SUBAGENT_DEPTH_NONE),
  };
}

/**
 * Why every `SubagentDefinition` is withheld: the provider's per-role config entry carries only
 * `description`, `config_file` and `nickname_candidates` (serde names at the pin); the rest lives
 * in a file this driver would have to write.
 */
export const CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON: string =
  "the provider's per-role config entry carries no inline model, tools, permission-mode, effort, or max-turns axis at the pinned build, so the definition cannot be realized without authoring a config file this driver does not own";

/** Fail-closed parse of `CreateSessionParams.config`. */
export function parseCodexSessionConfig(config: unknown): CodexSessionConfig {
  const source = readRecord(config, "CreateSessionParams.config");
  const cwd = readRequiredString(source, "cwd", "CreateSessionParams.config.cwd");
  const rawEnv = source["env"];
  if (!Array.isArray(rawEnv)) {
    throw new CodexDriverConfigError(
      "CreateSessionParams.config.env must be an array of [name, value] pairs.",
      "CreateSessionParams.config.env",
    );
  }
  const env = rawEnv.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0].length === 0
    ) {
      throw new CodexDriverConfigError(
        `CreateSessionParams.config.env[${index}] must be a [name, value] string pair.`,
        "CreateSessionParams.config.env",
      );
    }
    return [entry[0], entry[1]] as const;
  });
  // A present-but-empty account id refuses rather than reading as absent.
  const providerAccountId = readOptionalString(
    source,
    "providerAccountId",
    "CreateSessionParams.config.providerAccountId",
  );
  return {
    cwd,
    env,
    ...(providerAccountId === undefined ? {} : { providerAccountId }),
    ...parseCredentialEnvPolicy(source["credentialEnvPolicy"]),
  };
}

/**
 * Picks which claim names a spawn's provider account, for both spawn composers: the typed
 * `requested` member wins, `recorded` answers only when it is absent (never the manager-wide
 * `resumeSpawnConfig`), and two differing accounts throw because either choice would move the
 * run's spend silently. An empty `requested` throws too, since it skips the config parse.
 */
export function resolveBoundProviderAccountId(claims: {
  readonly requested: string | undefined;
  readonly requestedField: string;
  readonly recorded: string | undefined;
  readonly recordedField: string;
}): string | undefined {
  const { requested, requestedField, recorded, recordedField } = claims;
  if (requested !== undefined && requested.length === 0) {
    throw new CodexDriverConfigError(
      `${requestedField} must be a non-empty string when present.`,
      requestedField,
    );
  }
  if (requested === undefined) {
    return recorded;
  }
  if (recorded === undefined || recorded === requested) {
    return requested;
  }
  throw new CodexDriverConfigError(
    `${requestedField} names provider account ${requested} while ${recordedField} names ${recorded}; a spawn is billed to one account and neither resolver may silently win.`,
    requestedField,
  );
}

const ENV_NAME_MATCH_MODES: readonly SpawnEnvNameMatch[] = ["case-sensitive", "case-insensitive"];

/**
 * Fail-closed parse of the daemon's resolved credential policy. Absent is legitimate (a `trusted`
 * posture); a malformed one throws, since defaulting to "deny nothing" would spawn with the
 * variables the policy withholds. `envNameMatch` is required: guessing it could let `path` slip
 * past a list naming `PATH`.
 */
function parseCredentialEnvPolicy(
  value: unknown,
): { credentialEnvPolicy: CredentialEnvPolicy } | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  const label = "CreateSessionParams.config.credentialEnvPolicy";
  const source = readRecord(value, label);
  const rawDenyEnvVars = source["denyEnvVars"];
  if (!Array.isArray(rawDenyEnvVars)) {
    throw new CodexDriverConfigError(`${label}.denyEnvVars must be an array of names.`, label);
  }
  const denyEnvVars = rawDenyEnvVars.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new CodexDriverConfigError(
        `${label}.denyEnvVars[${index}] must be a non-empty string.`,
        label,
      );
    }
    return entry;
  });
  // `find`, not `some`: the match narrows the value to the union without a cast.
  const envNameMatch = ENV_NAME_MATCH_MODES.find((mode) => mode === source["envNameMatch"]);
  if (envNameMatch === undefined) {
    throw new CodexDriverConfigError(
      `${label}.envNameMatch must be one of ${ENV_NAME_MATCH_MODES.join(" | ")}.`,
      label,
    );
  }
  return { credentialEnvPolicy: { denyEnvVars, envNameMatch } };
}

/** Fail-closed parse of `StartRunParams.agentConfig`. */
export function parseCodexRunConfig(agentConfig: unknown): CodexRunConfig {
  const source = readRecord(agentConfig, "StartRunParams.agentConfig");
  // Parsed, not cast, so a malformed id fails here as a config error.
  const rawSessionId = readRequiredString(
    source,
    "sessionId",
    "StartRunParams.agentConfig.sessionId",
  );
  const parsedSessionId = SessionIdSchema.safeParse(rawSessionId);
  if (!parsedSessionId.success) {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.sessionId must be a session id.",
      "StartRunParams.agentConfig.sessionId",
      { cause: parsedSessionId.error },
    );
  }
  const sessionId = parsedSessionId.data;
  const input = readRequiredString(source, "input", "StartRunParams.agentConfig.input");
  const model = readOptionalString(source, "model", "StartRunParams.agentConfig.model");
  const clientUserMessageId = readOptionalString(
    source,
    "clientUserMessageId",
    "StartRunParams.agentConfig.clientUserMessageId",
  );
  // Read only to check it: the run-opening boundary mints its own frame origin, so any other value
  // is refused; a caller-declared tripwire-exempt origin would deliver the user's words as a
  // provider command.
  const declaredFrameOrigin = readOptionalString(
    source,
    "frameOrigin",
    "StartRunParams.agentConfig.frameOrigin",
  );
  if (declaredFrameOrigin !== undefined && declaredFrameOrigin !== RUN_OPENING_FRAME_ORIGIN) {
    throw new CodexDriverConfigError(
      `StartRunParams.agentConfig.frameOrigin cannot be declared; a run's opening text is written as "${RUN_OPENING_FRAME_ORIGIN}".`,
      "StartRunParams.agentConfig.frameOrigin",
    );
  }
  // Refused even when the value matches what the daemon derived; no comparison needed.
  for (const field of CALLER_DERIVED_TURN_POSTURE_FIELDS) {
    if (source[field] !== undefined) {
      throw new CodexDriverConfigError(
        `StartRunParams.agentConfig.${field} cannot be declared; the daemon derives every posture-affecting turn field.`,
        `StartRunParams.agentConfig.${field}`,
      );
    }
  }
  return {
    sessionId,
    input,
    ...(model === undefined ? {} : { model }),
    ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
  };
}

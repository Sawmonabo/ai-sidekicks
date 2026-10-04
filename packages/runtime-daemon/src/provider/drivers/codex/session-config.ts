/**
 * Reads the session and run configuration a Codex session is opened with, and turns the execution
 * posture and subagent policy into the thread, turn and config overrides Codex takes.
 */

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider-driver";
import { type CredentialEnvPolicy, type SpawnEnvNameMatch } from "../../spawn-env.js";
import { RUN_OPENING_FRAME_ORIGIN } from "../../outbound-frame.js";
import { isPlainObject } from "../../record-readers.js";
import { CodexDriverConfigError } from "./session-errors.js";
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
   * the child environment; absent only when no posture and no policy was declared. Re-derived from
   * the posture on every create and resume, never inherited from the original launch.
   */
  credentialEnvPolicy?: CredentialEnvPolicy | undefined;
}

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
 * not adjudicate `sandboxPolicy` with `permissions` (an `experimentalApi` connection, which this
 * driver's is, accepts both), so V1 realizes `sandboxPolicy`; `permissionProfile` refuses
 * `-32602` at the pin.
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
        `turn/start must not carry ${member}; V1 realizes the sandboxPolicy member of the ` +
          `posture pair.`,
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

/** Codex's thread-level sandbox (`SandboxMode` at the pin). */
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The sandbox each permission level runs in: Read Only at `readonly`, the workspace sandbox at the
 * three levels that write inside the workspace, and Full Access at `yolo`.
 */
const CODEX_SANDBOX_MODE_BY_PERMISSION_LEVEL: Readonly<
  Record<ExecutionPosture["mode"], CodexSandboxMode>
> = Object.freeze({
  readonly: "read-only",
  ask: "workspace-write",
  reviewed: "workspace-write",
  sandboxed: "workspace-write",
  yolo: "danger-full-access",
});

/**
 * The approval policy each permission level runs under: the three asking levels ask on request,
 * and `sandboxed` and `yolo` never ask. No level sends `untrusted`.
 */
const CODEX_APPROVAL_POLICY_BY_PERMISSION_LEVEL: Readonly<
  Record<ExecutionPosture["mode"], "on-request" | "never">
> = Object.freeze({
  readonly: "on-request",
  ask: "on-request",
  reviewed: "on-request",
  sandboxed: "never",
  yolo: "never",
});

/** Thread-level posture: `sandbox` and `approvalPolicy` on `thread/start`. */
interface CodexThreadPostureParams {
  readonly sandbox: CodexSandboxMode;
  readonly approvalPolicy: string;
}

/** The thread sandbox and approval policy a posture's permission level maps to. */
export function composeCodexThreadPosture(posture: ExecutionPosture): CodexThreadPostureParams {
  return {
    sandbox: CODEX_SANDBOX_MODE_BY_PERMISSION_LEVEL[posture.mode],
    approvalPolicy: CODEX_APPROVAL_POLICY_BY_PERMISSION_LEVEL[posture.mode],
  };
}

/**
 * Names the Codex sandbox modes two postures map to when they differ, or `undefined` when both run
 * in the same mode.
 */
export function findCodexSandboxModeDivergence(
  runPosture: ExecutionPosture,
  sessionPosture: ExecutionPosture,
): { readonly run: CodexSandboxMode; readonly session: CodexSandboxMode } | undefined {
  const run = CODEX_SANDBOX_MODE_BY_PERMISSION_LEVEL[runPosture.mode];
  const session = CODEX_SANDBOX_MODE_BY_PERMISSION_LEVEL[sessionPosture.mode];
  return run === session ? undefined : { run, session };
}

/**
 * Per-turn `sandboxPolicy`, sent every turn because it carries the writable roots the thread-level
 * mode cannot; the two exclude flags are pinned `true` so `writableRoots` is the complete list.
 * `providerNetworkAccess` is the person's own workspace network setting, read from the thread
 * reply.
 */
export function composeCodexTurnSandboxPolicy(
  posture: ExecutionPosture,
  providerNetworkAccess: boolean | undefined,
): Record<string, unknown> {
  switch (CODEX_SANDBOX_MODE_BY_PERMISSION_LEVEL[posture.mode]) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      // The person's network setting drives only the workspace sandbox; Codex's own Read Only
      // omits the member.
      return { type: "readOnly" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: posture.writableRoots,
        // Echoed, never omitted when known: Codex reads an omitted `networkAccess` as off.
        ...(providerNetworkAccess === undefined ? {} : { networkAccess: providerNetworkAccess }),
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
  "the provider's per-role config entry carries no inline model, tools, permission-mode, " +
  "effort, or max-turns axis at the pinned build, so the definition cannot be realized " +
  "without authoring a config file this driver does not own";

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
    `${requestedField} names provider account ${requested} while ${recordedField} names ` +
      `${recorded}; a spawn is billed to one account and neither resolver may silently win.`,
    requestedField,
  );
}

const ENV_NAME_MATCH_MODES: readonly SpawnEnvNameMatch[] = ["case-sensitive", "case-insensitive"];

/**
 * Fail-closed parse of the daemon's resolved credential policy. Absent is legitimate (a declared
 * posture supplies it); a malformed one throws, since defaulting to "deny nothing" would spawn with
 * the variables the policy withholds. `envNameMatch` is required: guessing it could let `path` slip
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
      `StartRunParams.agentConfig.frameOrigin cannot be declared; a run's opening text is ` +
        `written as "${RUN_OPENING_FRAME_ORIGIN}".`,
      "StartRunParams.agentConfig.frameOrigin",
    );
  }
  // Refused even when the value matches what the daemon derived; no comparison needed.
  for (const field of CALLER_DERIVED_TURN_POSTURE_FIELDS) {
    if (source[field] !== undefined) {
      throw new CodexDriverConfigError(
        `StartRunParams.agentConfig.${field} cannot be declared; the daemon derives every ` +
          `posture-affecting turn field.`,
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

/** Returns the value as an object, or throws a configuration error naming the label. */
function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new CodexDriverConfigError(`${label} must be an object.`, label);
  }
  return value;
}

/** Reads a non-empty string field, or throws a configuration error naming the label. */
function readRequiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string.`, label);
  }
  return value;
}

/**
 * Reads a non-empty string field, or undefined when it is absent; throws when present but empty or
 * not a string.
 */
function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string when present.`, label);
  }
  return value;
}

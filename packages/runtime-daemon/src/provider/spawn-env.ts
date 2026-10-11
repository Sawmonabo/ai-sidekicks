// The child environment of every process the daemon starts. Each starts from the login-shell base
// with the environment rows set over it, a row named for a credential home or for a variable the
// app sets dropped. A provider process, the version handshake and the auth probe included, then
// loses the curated credential variables and the names a provider must never receive, and gets the
// variables the app sets on that provider's process; a Codex conversation's commands receive the
// same base, rows and removals, without the process's own variables. A command the person's
// project runs, such as a setup command, and a Terminal pane's shell keep the curated credential
// variables.

import path from "node:path";

import {
  environmentNameRefusal,
  type EnvironmentRow,
} from "@ai-sidekicks/contracts/machine-settings";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { CURATED_CREDENTIAL_ENV_VARS } from "../policy/execution-posture-service.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "./driver/descriptor.js";

/** One child-environment entry, in the pair shape the PTY spawn surface takes. */
export type SpawnEnvPair = readonly [name: string, value: string];

/** How the host compares names; a case-insensitive host lets `path` slip past a deny of `PATH`. */
export type SpawnEnvNameMatch = "case-sensitive" | "case-insensitive";

/** A session's environment rows: the machine's `Every project` list and its project's own. */
export interface SessionEnvironmentRows {
  readonly everyProject: readonly EnvironmentRow[];
  /** Wins over an `Every project` row of the same name. */
  readonly project: readonly EnvironmentRow[];
}

/** What a provider process and a Codex conversation's commands both start from. */
export interface SessionSpawnEnvRequest {
  /**
   * The login shell's environment captured at the daemon's start; never the daemon's own
   * `process.env`.
   */
  readonly baseEnv: readonly SpawnEnvPair[];
  readonly environmentRows?: SessionEnvironmentRows | undefined;
  /** Every fold keys on it, so a base `disable_updates=0` cannot survive beside the opt-out. */
  readonly hostEnvNameMatch: SpawnEnvNameMatch;
}

/** The folders that pin a Claude Code process to one account, each an absolute path. */
export interface ClaudeAccountFolders {
  /** The configuration home, `CLAUDE_CONFIG_DIR`. */
  readonly configFolder: string;
  /** The account's credential store, `CLAUDE_SECURESTORAGE_CONFIG_DIR`. */
  readonly credentialStoreFolder: string;
}

/** The inputs to {@link buildProviderSpawnEnv} for one provider process. */
export type ProviderSpawnEnvRequest = SessionSpawnEnvRequest & {
  /**
   * Pairs a caller sets on this one process, such as the telemetry export's address and token or
   * the path of a program the daemon ships for the provider to run. Mandated like the opt-out and
   * exempt from the removals; a name another mandated pair claims throws.
   */
  readonly additionalMandatedPairs?: readonly SpawnEnvPair[] | undefined;
} & (
    | {
        readonly driverName: "claude";
        /** Absent, the process runs on the person's own default configuration and sign-in. */
        readonly accountFolders?: ClaudeAccountFolders | undefined;
      }
    | {
        readonly driverName: "codex";
        /** The account's `CODEX_HOME`; absent, the person's own `~/.codex`. */
        readonly codexHome?: string | undefined;
      }
  );

/**
 * A Codex conversation's `shell_environment_policy`: the service's environment is not inherited,
 * and every pair a command receives is in `set`.
 */
export interface CodexShellEnvironmentPolicy {
  readonly inherit: "none";
  readonly set: Readonly<Record<string, string>>;
}

/**
 * Two mandated values claim one name, thrown even for an equal repeat: last-wins could lower an
 * auto-update opt-out and first-wins would drop a pin. The message names the variables and never
 * their values, which can hold a credential.
 */
export class ProviderSpawnEnvConflictError extends Error {
  readonly conflictingName: string;

  constructor(conflictingName: string, message: string) {
    super(message);
    this.conflictingName = conflictingName;
    this.name = "ProviderSpawnEnvConflictError";
    this.conflictingName = conflictingName;
  }
}

/**
 * An account folder that is empty or not absolute; on Claude Code an empty credential store
 * silently runs the process on the person's own sign-in.
 */
export class ProviderAccountFolderError extends Error {
  readonly variableName: string;

  constructor(variableName: string, message: string) {
    super(message);
    this.name = "ProviderAccountFolderError";
    this.variableName = variableName;
  }
}

// Set on every Claude Code process: a tool-server call or a helper still running after 120 s moves
// to the background, a waiting dialog arms no deadline, and a background command's `timeout` is
// honored up to Claude Code's own cap.
const PROVIDER_PROCESS_ENVIRONMENT: Readonly<Record<ProviderName, readonly SpawnEnvPair[]>> =
  Object.freeze({
    claude: Object.freeze([
      ["CLAUDE_AUTO_BACKGROUND_TASKS", "1"],
      ["CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS", "0"],
      ["BASH_MAX_TIMEOUT_MS", "2147483647"],
    ] as const),
    codex: Object.freeze([]),
  });

// Removed even when the person's own shell sets them. On Claude Code the subprocess scrub forces
// the permission mode to `default`, the idle exit ends a process holding a pending wake-up, the
// removal-timeout switch hands a flagged removal to the auto-mode classifier, and the remote memory
// folder joins the per-session memories the daemon keeps apart.
const PROVIDER_WITHHELD_NAMES: Readonly<Record<ProviderName, readonly string[]>> = Object.freeze({
  claude: Object.freeze([
    "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
    "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY",
    "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
    "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  ]),
  codex: Object.freeze([]),
});

// The variables that name an account's folders; an empty one in a built environment is refused.
const ACCOUNT_FOLDER_NAMES: Readonly<Record<ProviderName, readonly string[]>> = Object.freeze({
  claude: Object.freeze(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]),
  codex: Object.freeze(["CODEX_HOME"]),
});

function toMatchKey(name: string, match: SpawnEnvNameMatch): string {
  return match === "case-insensitive" ? name.toUpperCase() : name;
}

// The credential-home variables, which only the daemon sets, from an account's own folders.
const CREDENTIAL_HOME_NAMES: readonly string[] = Object.values(ACCOUNT_FOLDER_NAMES).flat();

/**
 * The base with the rows set over it, minus the names `removedNames` lists, keyed under the host's
 * matching. A row named for a credential home or for a variable the app sets is dropped.
 */
function layerSessionEnvironment(
  request: SessionSpawnEnvRequest,
  removedNames: readonly string[],
): Map<string, SpawnEnvPair> {
  const nameMatch = request.hostEnvNameMatch;
  const removedKeys = new Set(removedNames.map((name) => toMatchKey(name, nameMatch)));
  const credentialHomeKeys = new Set(
    CREDENTIAL_HOME_NAMES.map((name) => toMatchKey(name, nameMatch)),
  );
  const rows = [
    ...(request.environmentRows?.everyProject ?? []),
    ...(request.environmentRows?.project ?? []),
  ].filter(
    (row) =>
      environmentNameRefusal(row.name) !== "set_by_app" &&
      !credentialHomeKeys.has(toMatchKey(row.name, nameMatch)),
  );

  // A later pair replaces an earlier one of its name, so a row beats the base and a project row
  // beats an `Every project` row, and the child receives one value per name.
  const layeredByKey = new Map<string, SpawnEnvPair>();
  for (const pair of [...request.baseEnv, ...rows.map((row) => [row.name, row.value] as const)]) {
    const key = toMatchKey(pair[0], nameMatch);
    if (!removedKeys.has(key)) {
      layeredByKey.set(key, [pair[0], pair[1]]);
    }
  }
  return layeredByKey;
}

function composeAccountFolderPairs(request: ProviderSpawnEnvRequest): SpawnEnvPair[] {
  const pairs: SpawnEnvPair[] = [];
  if (request.driverName === "claude" && request.accountFolders !== undefined) {
    pairs.push(
      ["CLAUDE_CONFIG_DIR", request.accountFolders.configFolder],
      ["CLAUDE_SECURESTORAGE_CONFIG_DIR", request.accountFolders.credentialStoreFolder],
    );
  }
  if (request.driverName === "codex" && request.codexHome !== undefined) {
    pairs.push(["CODEX_HOME", request.codexHome]);
  }
  for (const [name, value] of pairs) {
    if (!path.isAbsolute(value)) {
      throw new ProviderAccountFolderError(name, `${name} must be an absolute path.`);
    }
  }
  return pairs;
}

/**
 * The provider process's environment: the layered session environment, then every variable the
 * app sets on that provider's process, which no base pair or row can override. Throws
 * {@link ProviderSpawnEnvConflictError} when two mandated pairs claim one name, and
 * {@link ProviderAccountFolderError} for a relative account folder or an empty one in the result.
 */
export function buildProviderSpawnEnv(request: ProviderSpawnEnvRequest): readonly SpawnEnvPair[] {
  const nameMatch = request.hostEnvNameMatch;
  const mandatedByKey = new Map<string, SpawnEnvPair>();
  for (const pair of [
    ...Object.entries(PROVIDER_DRIVER_DESCRIPTORS[request.driverName].autoUpdateOptOutEnvironment),
    ...PROVIDER_PROCESS_ENVIRONMENT[request.driverName],
    ...composeAccountFolderPairs(request),
    ...(request.additionalMandatedPairs ?? []),
  ]) {
    const key = toMatchKey(pair[0], nameMatch);
    const declared = mandatedByKey.get(key);
    if (declared !== undefined) {
      throw new ProviderSpawnEnvConflictError(
        pair[0],
        `two mandated spawn-environment values claim the name ${pair[0]}, ` +
          `already claimed as ${declared[0]}`,
      );
    }
    mandatedByKey.set(key, [pair[0], pair[1]]);
  }

  const layeredByKey = layerSessionEnvironment(request, [
    ...CURATED_CREDENTIAL_ENV_VARS,
    ...PROVIDER_WITHHELD_NAMES[request.driverName],
  ]);
  for (const key of mandatedByKey.keys()) {
    layeredByKey.delete(key);
  }
  const built = [...layeredByKey.values(), ...mandatedByKey.values()];

  // An inherited empty account folder would move the process onto another sign-in unseen.
  const accountFolderKeys = new Set(
    ACCOUNT_FOLDER_NAMES[request.driverName].map((name) => toMatchKey(name, nameMatch)),
  );
  for (const [name, value] of built) {
    if (value.length === 0 && accountFolderKeys.has(toMatchKey(name, nameMatch))) {
      throw new ProviderAccountFolderError(name, `${name} is set to an empty value.`);
    }
  }
  return built;
}

/**
 * The environment a command the daemon runs for the person's project starts with, such as a
 * worktree's setup command or a Terminal pane's shell: the layered session environment, the
 * person's credential variables kept, since such a command may need them (`NPM_TOKEN` for a
 * private registry).
 */
export function buildCommandSpawnEnv(request: SessionSpawnEnvRequest): readonly SpawnEnvPair[] {
  return [...layerSessionEnvironment(request, []).values()];
}

/**
 * The `shell_environment_policy` a Codex conversation starts with: the session's layered
 * environment, the curated credential variables removed, for its commands to run under.
 */
export function composeCodexShellEnvironmentPolicy(
  request: SessionSpawnEnvRequest,
): CodexShellEnvironmentPolicy {
  return {
    inherit: "none",
    set: Object.fromEntries(
      layerSessionEnvironment(request, [
        ...CURATED_CREDENTIAL_ENV_VARS,
        ...PROVIDER_WITHHELD_NAMES.codex,
      ]).values(),
    ),
  };
}

/**
 * `environment` with `folder` first on its `PATH`, the variable's own spelling kept; a `PATH` it
 * lacks is set to `folder` alone. One pair per name, so the search and the spawn read one value.
 */
export function placeFolderFirstOnSearchPath(
  environment: readonly SpawnEnvPair[],
  folder: string,
  nameMatch: SpawnEnvNameMatch,
): readonly SpawnEnvPair[] {
  const pathKey = toMatchKey("PATH", nameMatch);
  let isPathSet = false;
  const placed = environment.map(([name, value]): SpawnEnvPair => {
    if (toMatchKey(name, nameMatch) !== pathKey) {
      return [name, value];
    }
    isPathSet = true;
    return [name, value === "" ? folder : `${folder}${path.delimiter}${value}`];
  });
  return isPathSet ? placed : [...placed, ["PATH", folder]];
}

/** The value of the first pair named exactly `name`, or `undefined` where none is. */
export function readSpawnEnvValue(
  environment: readonly SpawnEnvPair[],
  name: string,
): string | undefined {
  return environment.find(([pairName]) => pairName === name)?.[1];
}

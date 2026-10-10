// The command line a Codex service on an account home the app manages starts with: the listener
// and the `-c` switches every conversation on it shares. Each `-c` value is TOML, whose integers
// are 64-bit, so the largest holds below exceed what a JSON number keeps.

/** The daemon's two hook programs, as the command lines Codex runs for each tool call. */
export interface CodexHookCommands {
  /** Runs before each tool call; it holds a paused helper and answers the deadline's denial. */
  readonly preToolUse: string;
  /** Runs after each tool call. */
  readonly postToolUse: string;
}

/** The daemon's hooks a managed service starts with, and the socket their programs reach. */
export interface CodexDaemonHooks {
  readonly commands: CodexHookCommands;
  /** Starts listening for the hook programs, once; awaited before a service that runs them. */
  listen(): Promise<void>;
}

/**
 * The hook `timeout`, in seconds: the largest 64-bit integer divided by 1000, so the same hold also
 * fits the code-mode yield in milliseconds. Past `Number.MAX_SAFE_INTEGER`, so a string; a hook
 * that times out fails open, so the daemon denies a held call a few seconds before it.
 */
export const CODEX_HOOK_TIMEOUT_SECONDS = "9223372036854775";

/** The code-mode yield in milliseconds: the hook's hold, so a held call is never released early. */
const CODEX_CODE_MODE_YIELD_MS = `${CODEX_HOOK_TIMEOUT_SECONDS}000`;

/** Seconds a conversation no client holds stays loaded, so a moved one is free to resume soon. */
const CODEX_THREAD_UNLOAD_DELAY_SECONDS = "5";

/** What one service start carries beyond the switches every managed service shares. */
export interface CodexServiceCommandLineInput {
  /**
   * `unix://` for the home's own control socket, or `unix://<path>` for a second service that
   * starts beside the first on one home.
   */
  readonly listenAddress: string;
  /** The daemon's hook programs, inline; absent, the service starts with no daemon hooks. */
  readonly hookCommands: CodexHookCommands | undefined;
  /** More `key=value` switches another part of the daemon adds, such as the telemetry export. */
  readonly additionalConfigOverrides: readonly string[];
}

/** The arguments after the Codex command for one managed service. */
export function composeCodexServiceArguments(input: CodexServiceCommandLineInput): string[] {
  const overrides = [
    ...(input.hookCommands === undefined
      ? []
      : [
          composeHookOverride("PreToolUse", input.hookCommands.preToolUse),
          composeHookOverride("PostToolUse", input.hookCommands.postToolUse),
        ]),
    `features.code_mode.default_exec_yield_time_ms=${CODEX_CODE_MODE_YIELD_MS}`,
    "features.browser_use=false",
    `thread_unload_delay_secs=${CODEX_THREAD_UNLOAD_DELAY_SECONDS}`,
    // The session's compaction bound is a share of the whole window, so the limit counts the whole
    // context, Codex's own default, even where a config file chose only what follows the prefix.
    'model_auto_compact_token_limit_scope="total"',
    ...input.additionalConfigOverrides,
  ];
  return [
    "app-server",
    "--listen",
    input.listenAddress,
    ...overrides.flatMap((override) => ["-c", override]),
  ];
}

// JSON string syntax is a subset of a TOML basic string, so the command is quoted with it.
function composeHookOverride(eventName: "PreToolUse" | "PostToolUse", command: string): string {
  return (
    `hooks.${eventName}=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)},` +
    `timeout=${CODEX_HOOK_TIMEOUT_SECONDS}}]}]`
  );
}

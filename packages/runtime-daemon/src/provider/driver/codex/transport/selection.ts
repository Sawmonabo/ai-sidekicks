/**
 * Chooses how the Codex app server is reached (a child process on stdio or a Unix socket) and
 * composes the command line each choice needs.
 */

import { CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import { CodexDriverConfigError } from "../session/errors.js";

/**
 * How the daemon reaches the Codex app server; a daemon driver-registry setting, not an RPC payload
 * or a `ProviderDriver` member (`app-server --listen unix://`, config-gated, off by default).
 */
export type DriverTransportConfig =
  | { transport: "stdio" }
  | { transport: "unix-socket"; endpoint: string };

/**
 * Line the prelude emits once the tty is configured; nothing is written before it, because early
 * writes are echoed.
 */
export const CODEX_APP_SERVER_READY_SENTINEL: string = "__codex_app_server_ready__";

/**
 * The `sh -c` script: `stty`, readiness sentinel, then `exec` of the provider; `&&` makes a failed
 * `stty` a typed startup failure, and `"$@"` passes argv words unparsed so no path becomes shell
 * syntax. Windows needs an equivalent termios step or a non-PTY transport.
 *
 * A PTY slave starts canonical with echo on, and `codex app-server` never calls `tcsetattr`.
 * Canonical mode silently drops an input line over MAX_CANON (1024 bytes on Darwin; `codex-cli
 * 0.149.1` answered a 1015-byte frame, not a 1045-byte one), and splitting a frame across writes
 * does not help: the cap is per line, not per write.
 */
export const CODEX_APP_SERVER_SHELL_PRELUDE: string =
  `stty -icanon -echo` +
  ` && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL}` +
  ` && exec "$${CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME}" "$@"`;

/** The script's `$0` label; without it `sh -c` would take the first real argument as `$0`. */
export const CODEX_APP_SERVER_SHELL_ARGV0: string = "codex-app-server";

/** Default provider binary; overridable so a node-pinned path can be supplied. */
export const CODEX_DEFAULT_EXECUTABLE_PATH: string = "codex";

/**
 * How the daemon reaches one app-server process. The endpoint is the transport: a `--listen
 * unix://` server refuses a stdio `initialize`, so each arm reaches a process and never adds a
 * listener to the stdio one.
 */
export type CodexTransportSelection =
  | { readonly transport: "stdio" }
  | { readonly transport: "unix-socket"; readonly socketPath: string };

/**
 * Resolves the transport from registry config; absent config is `stdio`. A unix endpoint may be
 * `unix://` or a bare path. Throws `CodexDriverConfigError` for an empty endpoint.
 */
export function resolveCodexTransportSelection(
  config: DriverTransportConfig | undefined,
): CodexTransportSelection {
  if (config === undefined || config.transport === "stdio") {
    return { transport: "stdio" };
  }
  const socketPath = config.endpoint.startsWith(CODEX_UNIX_ENDPOINT_SCHEME)
    ? config.endpoint.slice(CODEX_UNIX_ENDPOINT_SCHEME.length)
    : config.endpoint;
  if (socketPath.length === 0) {
    throw new CodexDriverConfigError(
      "DriverTransportConfig.endpoint named no unix socket path.",
      "DriverTransportConfig.endpoint",
    );
  }
  return { transport: "unix-socket", socketPath };
}

const CODEX_UNIX_ENDPOINT_SCHEME = "unix://";

/**
 * The provider argv for one transport selection, as positional words appended after the prelude's
 * `$0`.
 */
export function composeCodexTransportArgv(selection: CodexTransportSelection): readonly string[] {
  switch (selection.transport) {
    case "stdio":
      // Left implicit: the default endpoint is the provider's own; no flag spelling is relied on.
      return ["app-server"];
    case "unix-socket":
      return ["app-server", "proxy", "--sock", selection.socketPath];
  }
}

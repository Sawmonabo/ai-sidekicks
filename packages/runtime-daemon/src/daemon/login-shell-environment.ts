// The environment every provider's environment is built from, captured once at each start. On
// macOS and Linux the daemon runs the person's login shell once as `<shell> -lic` with no input,
// has it print its environment with `env -0` between two marker lines, and keeps only what lies
// between them, so proxy, certificate and locale settings are there with no terminal open and a
// provider installed later is on the path. A shell that misses the deadline, or prints no markers,
// is ended and the start goes on with the account's own environment and one line in the service
// log; the start never waits on a shell. On Windows the service starts with the account's own
// environment.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { SpawnEnvPair } from "../provider/spawn-env.js";

/** How long the login shell may take before the start goes on without it. */
export const LOGIN_SHELL_DEADLINE_MS = 5_000;

// `exec` refuses an environment past the platform's argument limit (1 MiB on macOS, 2 MiB on
// Linux), so more output than this cannot hold a usable environment and the read stops there.
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** What one capture runs with. */
export interface LoginShellCaptureOptions {
  readonly platform: NodeJS.Platform;
  /** The person's login shell, `os.userInfo().shell`; `null` where the account names none. */
  readonly shell: string | null;
  readonly deadlineMs: number;
  /** The daemon's own environment: the fallback, and the environment the shell starts with. */
  readonly accountEnvironment: NodeJS.ProcessEnv;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
}

/**
 * Captures the base environment for provider processes as name-value pairs. Never rejects for a
 * shell that hangs, fails or prints no markers: it says why in the service log and returns the
 * account's own environment.
 */
export async function captureLoginShellEnvironment(
  options: LoginShellCaptureOptions,
): Promise<readonly SpawnEnvPair[]> {
  if (options.platform === "win32") {
    return toPairs(options.accountEnvironment);
  }
  if (options.shell === null || options.shell.length === 0) {
    options.writeServiceLog(
      "The account names no login shell, so providers start with the service's own environment.",
    );
    return toPairs(options.accountEnvironment);
  }
  const outcome = await runLoginShell(options.shell, options);
  if (outcome.kind === "captured") {
    return outcome.pairs;
  }
  options.writeServiceLog(
    `The login shell (${options.shell}) ${outcome.reason}, so providers start with the ` +
      "service's own environment.",
  );
  return toPairs(options.accountEnvironment);
}

type LoginShellOutcome =
  | { readonly kind: "captured"; readonly pairs: readonly SpawnEnvPair[] }
  | { readonly kind: "failed"; readonly reason: string };

function runLoginShell(
  shell: string,
  options: LoginShellCaptureOptions,
): Promise<LoginShellOutcome> {
  // Markers no rc file can print by chance, fresh at every start.
  const token = randomBytes(16).toString("hex");
  const beginMarker = `__sidekicks_environment_${token}_begin__`;
  const endMarker = `__sidekicks_environment_${token}_end__`;
  // `command` skips any alias or function an interactive rc file defines under these names.
  const script =
    `command printf '%s\\n' '${beginMarker}'; command env -0; ` +
    `command printf '\\n%s\\n' '${endMarker}'`;

  return new Promise<LoginShellOutcome>((resolve) => {
    // Its own process group, so the deadline ends whatever the rc files started with it.
    const child = spawn(shell, ["-lic", script], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: options.accountEnvironment,
    });
    const endLine = Buffer.from(`\n${endMarker}\n`, "utf8");
    let output = Buffer.alloc(0);
    let isSettled = false;

    const settle = (outcome: LoginShellOutcome, shouldEndGroup: boolean): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(deadline);
      child.stdout.destroy();
      if (shouldEndGroup && child.pid !== undefined) {
        endProcessGroup(child.pid);
      }
      resolve(outcome);
    };

    const deadline = setTimeout(() => {
      settle(
        { kind: "failed", reason: `did not finish within ${String(options.deadlineMs)} ms` },
        true,
      );
    }, options.deadlineMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      // Everything needed is in once the end marker arrives; a process the rc files left
      // holding the output open is then no reason to wait. Only the new bytes are searched.
      const searchFrom = Math.max(0, output.byteLength - chunk.byteLength - endLine.byteLength);
      const pairs =
        output.indexOf(endLine, searchFrom) === -1
          ? undefined
          : readBetweenMarkers(output.toString("utf8"), beginMarker, endMarker);
      if (pairs !== undefined) {
        settle({ kind: "captured", pairs }, false);
      } else if (output.byteLength > MAX_CAPTURE_BYTES) {
        settle({ kind: "failed", reason: "printed more than an environment can hold" }, true);
      }
    });
    child.on("error", (error) => {
      settle({ kind: "failed", reason: `could not be started (${error.message})` }, false);
    });
    child.on("close", () => {
      settle({ kind: "failed", reason: "printed no environment between the markers" }, false);
    });
  });
}

// The pairs `env -0` printed between the marker lines, or `undefined` until both have arrived.
// Entries end in NUL, so a value may hold newlines.
function readBetweenMarkers(
  text: string,
  beginMarker: string,
  endMarker: string,
): readonly SpawnEnvPair[] | undefined {
  const begin = text.indexOf(`${beginMarker}\n`);
  if (begin === -1) {
    return undefined;
  }
  const bodyStart = begin + beginMarker.length + 1;
  const end = text.indexOf(`\n${endMarker}\n`, bodyStart);
  if (end === -1) {
    return undefined;
  }
  const pairs: SpawnEnvPair[] = [];
  for (const entry of text.slice(bodyStart, end).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      pairs.push([entry.slice(0, separator), entry.slice(separator + 1)]);
    }
  }
  return pairs;
}

function toPairs(environment: NodeJS.ProcessEnv): readonly SpawnEnvPair[] {
  const pairs: SpawnEnvPair[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

function endProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    // The group can be gone already: the shell exited between the check and the kill.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

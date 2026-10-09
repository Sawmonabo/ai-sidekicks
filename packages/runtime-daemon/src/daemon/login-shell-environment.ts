// The environment every provider's environment is built from, captured once per start. On macOS
// and Linux the login shell runs once (`<shell> -lic`, printing `env -0` between two markers), so
// proxy, certificate and locale settings and a later-installed provider are present with no
// terminal open. A shell that stalls or prints no markers is ended and the start goes on with the
// account's default environment: the start never waits on a shell. Inside a WSL distribution the
// search path keeps no folder on the Windows drives. Windows uses the account's own.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import { endProcessTree } from "../process-tree.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import { describeRejection } from "../rejection.js";

/** How long the login shell may take before the start goes on without it. */
export const LOGIN_SHELL_DEADLINE_MS = 5_000;

// `exec` refuses an environment past the platform's argument limit (1 MiB on macOS, 2 MiB on
// Linux), so more output than this cannot hold a usable environment and the read stops there.
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

// The search path a login gets before any profile runs: `_PATH_DEFPATH` in `paths.h`, the same in
// the macOS SDK and in glibc.
const DEFAULT_LOGIN_PATH = "/usr/bin:/bin";

// `getconf` answers at once; a reading slower than this is treated as failed.
const USER_TEMP_DIRECTORY_DEADLINE_MS = 1_000;

const runProgram = promisify(execFile);

/**
 * Reads the account's private temporary folder on macOS, the `TMPDIR` a login session gets, with
 * `getconf DARWIN_USER_TEMP_DIR` run directly, never through a shell. Rejects when it fails.
 */
export async function readDarwinUserTempDirectory(): Promise<string> {
  const { stdout } = await runProgram("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    timeout: USER_TEMP_DIRECTORY_DEADLINE_MS,
  });
  return stdout.trimEnd();
}

/** What one capture runs with. */
export interface LoginShellCaptureOptions {
  readonly platform: NodeJS.Platform;
  /** The person's login shell, `os.userInfo().shell`; `null` where the account names none. */
  readonly shell: string | null;
  /** The person's home folder, `os.userInfo().homedir`. */
  readonly homeDirectory: string;
  /** The person's account name, `os.userInfo().username`. */
  readonly userName: string;
  /** Reads the account's temporary folder on macOS; consulted only when the capture falls back. */
  readonly readUserTempDirectory: () => Promise<string>;
  /** Reads where the Windows drives are mounted inside a WSL distribution; consulted on Linux. */
  readonly readWindowsDriveMounts: () => Promise<readonly string[]>;
  readonly deadlineMs: number;
  /** The daemon's own environment: the one the shell starts with, and the base on Windows. */
  readonly serviceEnvironment: NodeJS.ProcessEnv;
  /** Writes one line to the service log. */
  readonly writeServiceLog: (line: string) => void;
  /**
   * Abandons the capture: the shell and its group end. The abort's reason finishes the service
   * log's sentence on why, as in "was ended, since a stop came during the start".
   */
  readonly signal: AbortSignal;
}

/**
 * Captures the base environment for provider processes as name-value pairs. Never rejects for a
 * shell that hangs, fails, prints no markers or is abandoned: it says why in the service log and
 * returns the account's default environment: `HOME`, `SHELL` where the account names one, `USER`
 * and `LOGNAME`, `PATH` as `/usr/bin:/bin`, and on macOS `TMPDIR` when `getconf` reads it.
 */
export async function captureLoginShellEnvironment(
  options: LoginShellCaptureOptions,
): Promise<readonly SpawnEnvPair[]> {
  if (options.platform === "win32") {
    return toPairs(options.serviceEnvironment);
  }
  if (options.shell === null || options.shell.length === 0) {
    options.writeServiceLog(
      "The account names no login shell, so providers start with the account's default " +
        "environment.",
    );
    return await readDefaultEnvironment(options, null);
  }
  const outcome = await runLoginShell(options.shell, options);
  if (outcome.kind === "captured") {
    if (options.platform !== "linux") {
      return outcome.pairs;
    }
    return leaveOutWindowsDrives(outcome.pairs, await options.readWindowsDriveMounts());
  }
  // An abandoned capture belongs to a start that is failing or stopping, so no provider starts.
  options.writeServiceLog(
    outcome.kind === "abandoned"
      ? `The login shell (${options.shell}) ${outcome.reason}.`
      : `The login shell (${options.shell}) ${outcome.reason}, so providers start with the ` +
          "account's default environment.",
  );
  return await readDefaultEnvironment(options, options.shell);
}

// What a login gives before any profile runs. A `TMPDIR` that cannot be read is left out, with
// one line in the service log, and the start goes on.
async function readDefaultEnvironment(
  options: LoginShellCaptureOptions,
  shell: string | null,
): Promise<readonly SpawnEnvPair[]> {
  const pairs: SpawnEnvPair[] = [["HOME", options.homeDirectory]];
  if (shell !== null) {
    pairs.push(["SHELL", shell]);
  }
  pairs.push(["USER", options.userName], ["LOGNAME", options.userName]);
  pairs.push(["PATH", DEFAULT_LOGIN_PATH]);
  if (options.platform === "darwin") {
    const temporaryDirectory = await readUserTempDirectoryOrLog(options);
    if (temporaryDirectory !== undefined) {
      pairs.push(["TMPDIR", temporaryDirectory]);
    }
  }
  return pairs;
}

async function readUserTempDirectoryOrLog(
  options: LoginShellCaptureOptions,
): Promise<string | undefined> {
  let reason: string;
  try {
    const temporaryDirectory = await options.readUserTempDirectory();
    if (temporaryDirectory.length > 0) {
      return temporaryDirectory;
    }
    reason = "it printed nothing";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  options.writeServiceLog(
    `The account's temporary folder could not be read (${reason}), so providers start with no ` +
      "TMPDIR.",
  );
  return undefined;
}

type LoginShellOutcome =
  | { readonly kind: "captured"; readonly pairs: readonly SpawnEnvPair[] }
  | { readonly kind: "failed" | "abandoned"; readonly reason: string };

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
    if (options.signal.aborted) {
      resolve({ kind: "abandoned", reason: `was not run, since ${String(options.signal.reason)}` });
      return;
    }
    // Its own process group, so the deadline ends whatever the rc files started with it.
    const child = spawn(shell, ["-lic", script], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: options.serviceEnvironment,
    });
    const endLine = Buffer.from(`\n${endMarker}\n`, "utf8");
    // The output is joined once, when the end marker has arrived; until then only the bytes that
    // could start the marker across a chunk boundary are kept beside the new chunk for the search.
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let tail = Buffer.alloc(0);
    let isSettled = false;

    const settle = (outcome: LoginShellOutcome, shouldEndGroup: boolean): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimeout(deadline);
      options.signal.removeEventListener("abort", abandon);
      child.stdout.destroy();
      if (shouldEndGroup && child.pid !== undefined) {
        const processGroupId = child.pid;
        // Logged, not thrown: it runs from a timer or an abort, where a throw would end the daemon
        // over a cleanup.
        endProcessTree(processGroupId, "SIGKILL").catch((error: unknown) => {
          options.writeServiceLog(
            `The login shell's process group ${String(processGroupId)} could not be ended: ` +
              describeRejection(error),
          );
        });
      }
      resolve(outcome);
    };
    const abandon = (): void => {
      settle(
        { kind: "abandoned", reason: `was ended, since ${String(options.signal.reason)}` },
        true,
      );
    };

    const deadline = setTimeout(() => {
      settle(
        { kind: "failed", reason: `did not finish within ${String(options.deadlineMs)} ms` },
        true,
      );
    }, options.deadlineMs);
    options.signal.addEventListener("abort", abandon);

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      outputBytes += chunk.byteLength;
      // Everything needed is in once the end marker arrives; a process the rc files left
      // holding the output open is then no reason to wait.
      const searched = Buffer.concat([tail, chunk]);
      if (searched.indexOf(endLine) !== -1) {
        const pairs = readBetweenMarkers(
          Buffer.concat(chunks).toString("utf8"),
          beginMarker,
          endMarker,
        );
        if (pairs !== undefined) {
          settle({ kind: "captured", pairs }, false);
          return;
        }
      }
      tail = searched.subarray(Math.max(0, searched.byteLength - (endLine.byteLength - 1)));
      if (outputBytes > MAX_CAPTURE_BYTES) {
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

// A Windows program reached under a drive mount cannot run its Linux dependencies, so the search
// path drops every folder at or under one.
function leaveOutWindowsDrives(
  pairs: readonly SpawnEnvPair[],
  driveMounts: readonly string[],
): readonly SpawnEnvPair[] {
  if (driveMounts.length === 0) {
    return pairs;
  }
  const isOnDrive = (folder: string): boolean =>
    driveMounts.some((mount) => folder === mount || folder.startsWith(`${mount}/`));
  return pairs.map(
    ([name, value]): SpawnEnvPair =>
      name === "PATH"
        ? [
            name,
            value
              .split(":")
              .filter((folder) => !isOnDrive(folder))
              .join(":"),
          ]
        : [name, value],
  );
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

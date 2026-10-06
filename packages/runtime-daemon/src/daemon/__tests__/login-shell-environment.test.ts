// The environment captured from the login shell at each start: only what the shell prints between
// the two marker lines is kept, and a shell that hangs or prints no markers is ended and the start
// falls back to the account's default environment, never the service's own, with one line in the
// service log. That fallback holds the account's home, shell, user and login name and the default
// search path, plus on macOS its temporary folder, which is left out with a log line when it
// cannot be read. Inside a WSL distribution the search path loses its folders on the Windows
// drives. Each "shell" here is a small script run the way the login shell is,
// `<shell> -lic <script>`.

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureLoginShellEnvironment,
  readDarwinUserTempDirectory,
  type LoginShellCaptureOptions,
} from "../login-shell-environment.js";

const SERVICE_ENVIRONMENT = {
  PATH: "/opt/service/bin:/usr/bin:/bin",
  SERVICE_ONLY: "from the service",
};
const HOME_DIRECTORY = "/Users/person";
const USER_NAME = "person";
const USER_TEMP_DIRECTORY = "/var/folders/v5/abc123/T/";

let scratch: string;
let serviceLog: string[];
let temporaryDirectoryReads: number;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "aisk-shell-"));
  serviceLog = [];
  temporaryDirectoryReads = 0;
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeFakeShell(body: string): Promise<string> {
  const shellPath = path.join(scratch, "fake-shell");
  await writeFile(shellPath, `#!/bin/sh\n${body}\n`);
  await chmod(shellPath, 0o755);
  return shellPath;
}

function capture(
  shell: string | null,
  deadlineMs: number,
  overrides: Partial<
    Pick<LoginShellCaptureOptions, "platform" | "readUserTempDirectory" | "readWindowsDriveMounts">
  > = {},
) {
  return captureLoginShellEnvironment({
    platform: "darwin",
    shell,
    homeDirectory: HOME_DIRECTORY,
    userName: USER_NAME,
    readUserTempDirectory: () => {
      temporaryDirectoryReads += 1;
      return Promise.resolve(USER_TEMP_DIRECTORY);
    },
    readWindowsDriveMounts: () => Promise.resolve([]),
    deadlineMs,
    serviceEnvironment: SERVICE_ENVIRONMENT,
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
    signal: new AbortController().signal,
    ...overrides,
  });
}

// What a macOS login gives: none of the service's own variables, its PATH included.
function defaultEnvironment(shell: string): readonly (readonly [string, string])[] {
  return [
    ["HOME", HOME_DIRECTORY],
    ["SHELL", shell],
    ["USER", USER_NAME],
    ["LOGNAME", USER_NAME],
    ["PATH", "/usr/bin:/bin"],
    ["TMPDIR", USER_TEMP_DIRECTORY],
  ];
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe("captureLoginShellEnvironment", () => {
  it("keeps only the environment printed between the markers", async () => {
    // An rc file that exports a variable and prints around the command it is given ($2).
    const shell = await writeFakeShell(
      [
        "printf 'rc noise before\\n'",
        "export FROM_LOGIN_SHELL='two\nlines'",
        '/bin/sh -c "$2"',
        "printf 'rc noise after\\n'",
      ].join("\n"),
    );

    const pairs = await capture(shell, 10_000);

    const environment = new Map(pairs);
    expect(environment.get("FROM_LOGIN_SHELL")).toBe("two\nlines");
    expect(environment.get("SERVICE_ONLY")).toBe("from the service");
    expect(pairs.filter(([name, value]) => `${name}=${value}`.includes("noise"))).toStrictEqual([]);
    expect(serviceLog).toStrictEqual([]);
    // The temporary folder is read only for the fallback.
    expect(temporaryDirectoryReads).toBe(0);
  });

  it("drops the search path's folders on the Windows drives inside WSL", async () => {
    // WSL appends the Windows search path under the drive mounts; `/mnt/cx` is no drive.
    const shell = await writeFakeShell(
      [
        "export PATH='/home/person/.local/bin:/mnt/c/Program Files/nodejs:/mnt/c:/mnt/cx/bin:" +
          "/usr/bin'",
        '/bin/sh -c "$2"',
      ].join("\n"),
    );

    const pairs = await capture(shell, 10_000, {
      platform: "linux",
      readWindowsDriveMounts: () => Promise.resolve(["/mnt/c", "/mnt/d"]),
    });

    expect(new Map(pairs).get("PATH")).toBe("/home/person/.local/bin:/mnt/cx/bin:/usr/bin");
    expect(new Map(pairs).get("SERVICE_ONLY")).toBe("from the service");
  });

  it("ends a shell that misses the deadline, with whatever it started, and falls back", async () => {
    const backgroundProcessFile = path.join(scratch, "background-pid");
    // An rc file that starts a background process and then waits on input that never comes.
    const shell = await writeFakeShell(
      [`sleep 60 &`, `echo $! > '${backgroundProcessFile}'`, "sleep 60"].join("\n"),
    );

    const pairs = await capture(shell, 300);

    expect(pairs).toStrictEqual(defaultEnvironment(shell));
    expect(serviceLog).toStrictEqual([
      `The login shell (${shell}) did not finish within 300 ms, so providers start with the ` +
        "account's default environment.",
    ]);
    const backgroundProcessId = Number((await readFile(backgroundProcessFile, "utf8")).trim());
    // The kill is delivered asynchronously; give it a moment before checking.
    const giveUpAt = Date.now() + 2_000;
    while (isProcessAlive(backgroundProcessId) && Date.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isProcessAlive(backgroundProcessId)).toBe(false);
  });

  it("falls back when the shell exits without printing the markers", async () => {
    const shell = await writeFakeShell("printf 'PATH=/somewhere/else\\n'");

    const pairs = await capture(shell, 10_000);

    expect(pairs).toStrictEqual(defaultEnvironment(shell));
    expect(serviceLog).toStrictEqual([
      `The login shell (${shell}) printed no environment between the markers, so providers ` +
        "start with the account's default environment.",
    ]);
  });

  it("gives an account that names no shell its default environment, with no TMPDIR on Linux", async () => {
    const pairs = await capture(null, 10_000, { platform: "linux" });

    expect(pairs).toStrictEqual([
      ["HOME", HOME_DIRECTORY],
      ["USER", USER_NAME],
      ["LOGNAME", USER_NAME],
      ["PATH", "/usr/bin:/bin"],
    ]);
    expect(temporaryDirectoryReads).toBe(0);
    expect(serviceLog).toStrictEqual([
      "The account names no login shell, so providers start with the account's default " +
        "environment.",
    ]);
  });

  it.each([
    {
      label: "fails",
      read: () => Promise.reject(new Error("getconf exited 1")),
      reason: "getconf exited 1",
    },
    { label: "prints nothing", read: () => Promise.resolve(""), reason: "it printed nothing" },
  ])("leaves TMPDIR out and says why when getconf $label", async ({ read, reason }) => {
    const pairs = await capture(null, 10_000, { readUserTempDirectory: read });

    expect(pairs).toStrictEqual([
      ["HOME", HOME_DIRECTORY],
      ["USER", USER_NAME],
      ["LOGNAME", USER_NAME],
      ["PATH", "/usr/bin:/bin"],
    ]);
    expect(serviceLog).toStrictEqual([
      "The account names no login shell, so providers start with the account's default " +
        "environment.",
      `The account's temporary folder could not be read (${reason}), so providers start with no ` +
        "TMPDIR.",
    ]);
  });
});

describe.runIf(process.platform === "darwin")("readDarwinUserTempDirectory", () => {
  it("reads the account's own temporary folder from getconf", async () => {
    const temporaryDirectory = await readDarwinUserTempDirectory();

    expect(temporaryDirectory).toMatch(/^\/var\/folders\/.+\/T\/$/);
    expect((await stat(temporaryDirectory)).isDirectory()).toBe(true);
  });
});

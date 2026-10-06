// The environment captured from the login shell at each start: only what the shell prints between
// the two marker lines is kept, and a shell that hangs or prints no markers is ended and the start
// falls back to the account's default environment, never the service's own, with one line in the
// service log. Each "shell" here
// is a small script run the way the login shell is, `<shell> -lic <script>`.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureLoginShellEnvironment } from "../login-shell-environment.js";

const SERVICE_ENVIRONMENT = {
  PATH: "/opt/service/bin:/usr/bin:/bin",
  SERVICE_ONLY: "from the service",
};
const HOME_DIRECTORY = "/Users/person";

let scratch: string;
let serviceLog: string[];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "aisk-shell-"));
  serviceLog = [];
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

function capture(shell: string, deadlineMs: number) {
  return captureLoginShellEnvironment({
    platform: "darwin",
    shell,
    homeDirectory: HOME_DIRECTORY,
    deadlineMs,
    serviceEnvironment: SERVICE_ENVIRONMENT,
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
    signal: new AbortController().signal,
  });
}

// What the passwd entry gives: none of the service's own variables, its PATH included.
function defaultEnvironment(shell: string): readonly (readonly [string, string])[] {
  return [
    ["HOME", HOME_DIRECTORY],
    ["SHELL", shell],
    ["PATH", "/usr/bin:/bin"],
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
});

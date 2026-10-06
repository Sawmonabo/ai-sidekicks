// Fixture git for tests that need a real repository: an environment no developer setting can
// reach, and spawns that resolve on any exit or reject on a non-zero one.

import { execFile } from "node:child_process";
import { join } from "node:path";

import { NEUTRALIZED_GIT_ENV_KEYS } from "../process.js";

/** Wall-clock ceiling for one fixture git spawn; a hung spawn fails naming its command. */
export const FIXTURE_GIT_TIMEOUT_MS = 30_000;

/**
 * The environment fixture git runs under: no system or global config, a `HOME` inside the temp
 * root, an explicit identity, and none of the `GIT_*` variables the daemon strips (a `GIT_DIR`
 * leaking in from the harness would point fixture commands at the repository under development),
 * so a developer's git setup cannot change what a test observes. `overrides` layer on top.
 */
export function buildFixtureEnvironment(
  fixtureRoot: string,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of NEUTRALIZED_GIT_ENV_KEYS) {
    delete environment[key];
  }
  environment["HOME"] = fixtureRoot;
  environment["XDG_CONFIG_HOME"] = join(fixtureRoot, "xdg");
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  // A path that does not exist, inside the temp root; unlike `/dev/null` it works on every
  // platform.
  environment["GIT_CONFIG_GLOBAL"] = join(fixtureRoot, "absent-global-gitconfig");
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  environment["GIT_AUTHOR_NAME"] = "Fixture Author";
  environment["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid";
  environment["GIT_COMMITTER_NAME"] = "Fixture Author";
  environment["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid";
  return { ...environment, ...overrides };
}

/** One fixture git spawn that ran to an exit. */
export interface FixtureGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawns fixture git and resolves on any exit status, so a command that answers by exit code
 * (`merge-base --is-ancestor`) can be asked. Rejects only when git did not run (a string `code` or
 * none). Stdin is always closed, so a command that reads it cannot hang on the test runner's.
 */
export function spawnFixtureGit(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  stdin?: string,
): Promise<FixtureGitResult> {
  return new Promise<FixtureGitResult>((resolve, reject) => {
    const child = execFile(
      "git",
      [...argv],
      { encoding: "utf8", env: environment, cwd, timeout: FIXTURE_GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const reportedCode: number | string | null | undefined = error.code;
        if (typeof reportedCode !== "number") {
          reject(new Error(`fixture git ${argv.join(" ")} did not run: ${String(error.message)}`));
          return;
        }
        resolve({ exitCode: reportedCode, stdout, stderr });
      },
    ).on("error", reject);
    const childStdin = child.stdin;
    if (childStdin !== null) {
      childStdin.on("error", () => {
        /* the invocation's failure already travels on the exit status */
      });
      if (stdin !== undefined) {
        childStdin.write(stdin);
      }
      childStdin.end();
    }
  });
}

/**
 * Runs a fixture git command, resolving with its stdout and rejecting on any non-zero exit. `cwd`
 * stays inside the fixture root so git cannot discover the repository under development.
 */
export async function runFixtureGit(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const result: FixtureGitResult = await spawnFixtureGit(args, environment, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

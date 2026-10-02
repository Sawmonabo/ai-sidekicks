// Fixtures shared by the workspace tests: hermetic real git, a seeded session, a stepping clock and
// a rejection catcher, which the worktree tests use too.

import { execFile } from "node:child_process";
import { join } from "node:path";

import type { SessionId } from "@ai-sidekicks/contracts";

import type { Database } from "better-sqlite3";

import { insertStoredEvent } from "../../session/__tests__/stored-event.test-support.js";
import { DISCOVERY_REDIRECTING_GIT_ENV_KEYS } from "../repo-root-resolver.js";

/**
 * The environment fixture git runs under: no system or global config, a `HOME` inside the temp
 * root, an explicit identity, and no discovery-redirecting `GIT_*` variable, so a developer's git
 * setup cannot change what a test observes.
 */
export function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
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
  return environment;
}

/**
 * Runs a fixture git command, resolving with its stdout and rejecting on any non-zero exit. `cwd`
 * stays inside the fixture root so git cannot discover the repository under development.
 */
export function runFixtureGit(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { encoding: "utf8", env: environment, cwd, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`fixture git ${args.join(" ")} failed: ${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Seeds a session's log so `SessionService.replay` returns a snapshot for it. */
export function seedSession(database: Database, sessionId: SessionId): void {
  insertStoredEvent(database, {
    id: `evt-${sessionId}`,
    sessionId,
    sequence: 0,
    occurredAt: "2026-08-05T00:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    payload: { sessionId },
    correlationId: null,
    causationId: null,
    version: "1.0",
  });
}

/**
 * A clock that advances one second per read, so two stamps never tie: `toISOString` has
 * millisecond resolution and two reads microseconds apart give the same string.
 */
export function steppingClock(): () => string {
  let currentMs: number = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const stamp = new Date(currentMs).toISOString();
    currentMs += 1_000;
    return stamp;
  };
}

/** Runs `body` and returns what it rejected with; throws if it resolved. */
export async function captureRejection(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

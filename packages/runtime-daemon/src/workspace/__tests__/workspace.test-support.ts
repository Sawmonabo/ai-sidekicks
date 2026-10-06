// Fixtures shared by the workspace and worktree tests: hermetic real git, a seeded session, a
// stepping clock, a rejection catcher, and raw-SQL readers for mount, workspace and event rows.

import { execFile } from "node:child_process";
import { join } from "node:path";

import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Database } from "better-sqlite3";

import { NEUTRALIZED_GIT_ENV_KEYS } from "../../git/process.js";
import { insertStoredEvent } from "../../session/__tests__/stored-event.test-support.js";
import type { DirectoryReadabilityProbe } from "../trust-envelope.js";
import type { WorkspaceService } from "../workspace-service.js";

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

/** Seeds a session's log so `SessionService.rebuildSession` returns a snapshot for it. */
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

/** A readability probe that admits every directory, for resolvers over synthetic paths. */
export const alwaysReadableProbe: DirectoryReadabilityProbe = () => Promise.resolve();

// Row and event readers use raw SQL, not a service call: durability is a claim about what is on
// disk, and reading back through the writing service would prove only that it agrees with itself.

/** A `repo_mounts` row as stored. */
interface StoredMountRow {
  readonly id: string;
  readonly node_id: string;
  readonly local_path: string;
  readonly canonical_root: string;
  readonly vcs_type: string;
  readonly state: string;
  readonly attached_at: string;
  readonly updated_at: string;
}

/** A `workspaces` row as stored. */
interface StoredWorkspaceRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly metadata: string;
  readonly updated_at: string;
}

/** A `session_events` row's envelope columns, payload still serialized. */
interface StoredEventEnvelopeRow {
  readonly type: string;
  readonly actor: string | null;
  readonly correlation_id: string | null;
  readonly payload: string;
}

function readMountRow(database: Database, repoMountId: string): StoredMountRow | undefined {
  return database
    .prepare(
      `SELECT id, node_id, local_path, canonical_root, vcs_type, state, attached_at, updated_at
         FROM repo_mounts WHERE id = ?`,
    )
    .get(repoMountId) as StoredMountRow | undefined;
}

/** Reads one mount row; throws when none has the id. */
export function requireMountRow(database: Database, repoMountId: string): StoredMountRow {
  const row = readMountRow(database, repoMountId);
  if (row === undefined) {
    throw new Error(`repo mount ${repoMountId} is absent; the caller expected a row`);
  }
  return row;
}

/** Reads one workspace row, or `undefined` when none has the id. */
export function readWorkspaceRow(
  database: Database,
  workspaceId: string,
): StoredWorkspaceRow | undefined {
  return database
    .prepare(
      `SELECT id, session_id, repo_mount_id, execution_mode, fs_root, state, metadata, updated_at
         FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as StoredWorkspaceRow | undefined;
}

/** Reads one workspace row; throws when none has the id. */
export function requireWorkspaceRow(database: Database, workspaceId: string): StoredWorkspaceRow {
  const row = readWorkspaceRow(database, workspaceId);
  if (row === undefined) {
    throw new Error(`workspace ${workspaceId} is absent; the caller expected a row`);
  }
  return row;
}

/**
 * The session's event types in sequence order, without the seeded `session.created` anchor, which
 * exists only because `rebuildSession` refuses a log that does not start with it.
 */
export function readLifecycleEventTypes(database: Database, sessionId: string): readonly string[] {
  return readLifecycleEnvelopes(database, sessionId).map((row) => row.type);
}

/** The session's event envelopes in sequence order, without the seeded `session.created` anchor. */
export function readLifecycleEnvelopes(
  database: Database,
  sessionId: string,
): readonly StoredEventEnvelopeRow[] {
  return (
    database
      .prepare(
        `SELECT type, actor, correlation_id, payload FROM session_events
          WHERE session_id = ? ORDER BY sequence ASC`,
      )
      .all(sessionId) as readonly StoredEventEnvelopeRow[]
  ).filter((row) => row.type !== "session.created");
}

/** Binds a bound-root workspace and completes its preparation at `fsRoot`, so it is `ready`. */
export async function bindReadyWorkspace(
  workspaces: WorkspaceService,
  sessionId: SessionId,
  repoMountId: RepoMountId,
  fsRoot: string,
): Promise<string> {
  const bound = await workspaces.bind({ sessionId, repoMountId, executionMode: "bound-root" });
  await workspaces.completeRootPreparation(bound.workspaceId, fsRoot);
  return String(bound.workspaceId);
}

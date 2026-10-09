// A real git repository in a temporary folder for the worktree tests, the git runner the services
// use against it, and a snapshot of a checkout as the person sees it, for proving a step changed
// nothing or put everything back.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  buildFixtureEnvironment,
  spawnFixtureGit,
  type FixtureGitResult,
} from "../../__fixtures__/command.js";
import { runGitWithExecFile, type GitRunner } from "../../process.js";

/** The branch every fixture repository starts on. */
const FIXTURE_DEFAULT_BRANCH = "main";

// The keys that keep the daemon's runner off the developer's git configuration and identity.
const ISOLATING_ENVIRONMENT_KEYS: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/** One repository with a first commit, inside a fixture root that holds everything a test makes. */
export interface FixtureRepository {
  /** The temporary folder, resolved, since git reports `/private/var` where macOS hands `/var`. */
  readonly fixtureRoot: string;
  /** The repository's own checkout. */
  readonly root: string;
  /** The daemon's runner, kept off the developer's git configuration. */
  readonly runner: GitRunner;
  /** Runs fixture git in `cwd` (the checkout by default); throws on a non-zero exit. */
  git(argv: readonly string[], cwd?: string): Promise<string>;
  gitCapturing(argv: readonly string[], cwd?: string): Promise<FixtureGitResult>;
  /** Writes a file under `folder`, making its parent folders. */
  write(folder: string, path: string, content: string): Promise<void>;
  remove(): void;
}

/**
 * Creates a repository on `main` with `README.md`, `src/app.ts` and an ignored `.env` rule, its
 * first commit already on `origin/main`.
 */
export async function createFixtureRepository(): Promise<FixtureRepository> {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "aisk-worktree-")));
  const root = join(fixtureRoot, "repository");
  mkdirSync(root, { recursive: true });
  const environment = buildFixtureEnvironment(fixtureRoot);
  const isolation: Record<string, string> = {};
  for (const key of ISOLATING_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      isolation[key] = value;
    }
  }
  const gitCapturing = (argv: readonly string[], cwd: string = root): Promise<FixtureGitResult> =>
    spawnFixtureGit(argv, environment, cwd);
  const git = async (argv: readonly string[], cwd: string = root): Promise<string> => {
    const result = await gitCapturing(argv, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`fixture git ${argv.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
    }
    return result.stdout.trimEnd();
  };
  const write = async (folder: string, path: string, content: string): Promise<void> => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  };

  await git(["init", "-q", "-b", FIXTURE_DEFAULT_BRANCH, "."]);
  await write(root, "README.md", "# fixture repository\n");
  await write(root, "src/app.ts", "export const answer: number = 42;\n");
  await write(root, ".gitignore", ".env\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "initial commit"]);
  // A remote-tracking branch at the first commit, so a tree cut from it has nothing unpushed.
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

  return {
    fixtureRoot,
    root,
    runner: (argv, options) =>
      runGitWithExecFile(argv, {
        ...options,
        environmentOverrides: { ...isolation, ...options.environmentOverrides },
      }),
    git,
    gitCapturing,
    write,
    remove: () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

/** A checkout as the person sees it: every entry's bytes, the staged set, status and HEAD. */
export interface CheckoutSnapshot {
  /** `<relative path> <sha256>` for every file outside `.git`, ignored ones included, sorted. */
  readonly entries: readonly string[];
  /** `git ls-files --stage`: the staged set, object ids included. */
  readonly stagedSet: string;
  /** `git status --porcelain --ignored`. */
  readonly status: string;
  readonly headCommit: string;
  /** The ref HEAD names, or `null` while detached. */
  readonly headRef: string | null;
}

/** Reads `folder`'s snapshot through fixture git. */
export async function snapshotCheckout(
  repository: FixtureRepository,
  folder: string,
): Promise<CheckoutSnapshot> {
  const headRef = await repository.gitCapturing(["symbolic-ref", "--quiet", "HEAD"], folder);
  return {
    entries: hashEntries(folder),
    stagedSet: await repository.git(["ls-files", "--stage"], folder),
    status: await repository.git(["status", "--porcelain", "--ignored"], folder),
    headCommit: await repository.git(["rev-parse", "HEAD"], folder),
    headRef: headRef.exitCode === 0 ? headRef.stdout.trim() : null,
  };
}

/**
 * `<relative path> <sha256>` for every file under `root` outside `.git`, sorted: a folder's content
 * read without git, for a copy whose record is gone. A linked tree's `.git` is a one-line pointer a
 * put-back rewrites to a new record, so it is skipped.
 */
export function hashEntries(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.name === ".git") {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      entries.push(`${relative(root, path)} ${digest}`);
    }
  };
  walk(root);
  return entries.sort();
}

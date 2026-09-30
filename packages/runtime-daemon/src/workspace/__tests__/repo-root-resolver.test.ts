// Proves the repo-root resolver returns only the canonical toplevel real git reports for an
// absolute input, and otherwise refuses with a typed reason: relative or drive-less input, a
// missing path, a git that cannot run, a redirected root, or ambient GIT_* redirection.

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RepoRootResolutionError, type RepoRootResolutionReason } from "../repo-errors.js";
import {
  RepoRootResolver,
  type GitCommandOptions,
  type GitCommandResult,
  type GitFileExecutor,
} from "../repo-root-resolver.js";

import { buildFixtureEnvironment, runFixtureGit } from "./workspace-test-support.js";

// The hanging-git fixture is a `/bin/sh` script.
const onPosix = describe.skipIf(process.platform === "win32");

// ----------------------------------------------------------------------------
// Real-git fixtures
// ----------------------------------------------------------------------------

/** Every path the suite resolves against, all rooted in one realpath'd temp dir. */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly repositoryRoot: string;
  readonly nestedDirectory: string;
  readonly symlinkToNestedDirectory: string;
  readonly plainDirectory: string;
  readonly siblingRedirectRoot: string;
  readonly ancestorRedirectRoot: string;
  readonly missingGitExecutable: string;
  readonly hangingGitScript: string;
}

let fixtures: Fixtures;

beforeAll(async () => {
  // On macOS `os.tmpdir()` is a symlink into `/private/var/folders/...`, which the resolver
  // canonicalizes, so every expected value derives from the realpath'd root.
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "repo-root-resolver-")));
  const environment = buildFixtureEnvironment(fixtureRoot);

  const repositoryRoot = join(fixtureRoot, "repo");
  const nestedDirectory = join(repositoryRoot, "nested", "deep");
  const plainDirectory = join(fixtureRoot, "plain");
  const scriptDirectory = join(fixtureRoot, "fake-bin");

  await mkdir(nestedDirectory, { recursive: true });
  await mkdir(plainDirectory, { recursive: true });
  await mkdir(scriptDirectory, { recursive: true });

  const symlinkToNestedDirectory = join(fixtureRoot, "link-to-nested");
  await symlink(nestedDirectory, symlinkToNestedDirectory);

  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);

  // Redirect fixtures: a repository whose own config sets `core.worktree`, which moves
  // `--show-toplevel`. One fixture per verification check, because neither check catches both.
  //
  // Sibling: pointed at the fixture repository, which self-reports, so only containment refuses it.
  const siblingRedirectRoot = join(fixtureRoot, "sibling-redirect");
  await runFixtureGit(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "sibling-redirect-gitdir")}`,
      siblingRedirectRoot,
    ],
    environment,
    fixtureRoot,
  );
  await runFixtureGit(
    ["-C", siblingRedirectRoot, "config", "core.worktree", repositoryRoot],
    environment,
    fixtureRoot,
  );

  // Ancestor: pointed at the attached directory's own parent, so containment passes and only the
  // self-report check refuses it.
  const ancestorRedirectContainer = join(fixtureRoot, "ancestor-container");
  const ancestorRedirectRoot = join(ancestorRedirectContainer, "attached");
  await runFixtureGit(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "ancestor-redirect-gitdir")}`,
      ancestorRedirectRoot,
    ],
    environment,
    fixtureRoot,
  );
  await runFixtureGit(
    ["-C", ancestorRedirectRoot, "config", "core.worktree", ancestorRedirectContainer],
    environment,
    fixtureRoot,
  );

  // `exec` keeps the sleeping process the direct child: a forked grandchild would survive the kill
  // holding the stdio pipes, and `execFile`'s callback would not fire until they closed.
  const hangingGitScript = join(scriptDirectory, "hanging-git");
  await writeFile(hangingGitScript, "#!/bin/sh\nexec sleep 30\n", "utf8");
  await chmod(hangingGitScript, 0o755);

  fixtures = {
    fixtureRoot,
    repositoryRoot,
    nestedDirectory,
    symlinkToNestedDirectory,
    plainDirectory,
    siblingRedirectRoot,
    ancestorRedirectRoot,
    missingGitExecutable: join(scriptDirectory, "definitely-not-a-git-binary"),
    hangingGitScript,
  };
}, 120_000);

afterAll(async () => {
  if (fixtures !== undefined) {
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface RecordedInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: GitCommandOptions;
}

/**
 * Answers each invocation from its `-C` directory (`args[1]`), so a case can say "the input
 * reports X, and X reports Y" without encoding the resolver's call order.
 */
function directoryAnsweringExecutor(
  recorded: RecordedInvocation[],
  answerFor: (directory: string) => string,
): GitFileExecutor {
  return (file: string, args: readonly string[], options: GitCommandOptions) => {
    recorded.push({ file, args, options });
    return Promise.resolve<GitCommandResult>({ stdout: answerFor(args[1] ?? ""), stderr: "" });
  };
}

/** Asserts the rejection is the typed carrier with the expected reason. */
async function expectResolutionFailure(
  resolving: Promise<unknown>,
  reason: RepoRootResolutionReason,
): Promise<RepoRootResolutionError> {
  const thrown: unknown = await resolving.then(
    (value: unknown) => {
      throw new Error(
        `expected RepoRootResolutionError(${reason}) but resolved with ${JSON.stringify(value)}`,
      );
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(RepoRootResolutionError);
  const failure = thrown as RepoRootResolutionError;
  expect(failure.reason).toBe(reason);
  expect(failure.code).toBe("repo.root_resolution_failed");
  return failure;
}

describe("canonical resolution against real git", () => {
  it("resolves a nested subdirectory to the repository toplevel", async () => {
    // The user-selected path is not the repo root; the resolver must walk to the real toplevel.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toBe(fixtures.nestedDirectory);
  });

  it("refuses a plain directory with not_a_git_repository", async () => {
    // git's positive verdict on a directory with no `.git` entry; the only route to
    // `not_a_git_repository`.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });
});

describe("symlink canonicalization", () => {
  it("resolves a symlink to a repo subdirectory to the symlink-resolved toplevel", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.symlinkToNestedDirectory,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toContain("link-to-nested");
  });
});

describe("non-absolute input is refused before resolution", () => {
  it("refuses a bare relative path with not_absolute, not a filesystem reason", async () => {
    // `realpath` would complete a relative path from the daemon's working directory, a guess from
    // daemon state rather than the author's context.
    const failure = await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot("src/workspace"),
      "not_absolute",
    );
    expect(failure.reason).not.toBe("path_not_found");
    expect(failure.reason).not.toBe("vcs_error");
    expect(failure.reason).not.toBe("not_readable");
  });

  it("refuses a backslash-rooted path that names no drive", async () => {
    // `\repos\foo` is absolute to `path.win32` but names no volume, so resolving it would take
    // the volume from the daemon's current drive.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\repos\foo`,
      ),
      "not_absolute",
    );
  });
});

describe("explicit failure on an unusable path", () => {
  it("throws path_not_found for a nonexistent path", async () => {
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(join(fixtures.fixtureRoot, "no-such-directory")),
      "path_not_found",
    );
  });
});

describe("a git that cannot run is vcs_error, never not_a_git_repository", () => {
  it("surfaces vcs_error when the git executable does not exist", async () => {
    // Real `execFile` against a nonexistent path, so the ENOENT is Node's own. A host without git
    // must not report a real repository as not being one.
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.missingGitExecutable,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "vcs_error",
    );
  });
});

onPosix("a git that cannot run — POSIX process fixtures", () => {
  it("surfaces vcs_error when git exceeds the invocation timeout", async () => {
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.hangingGitScript,
      gitCommandTimeoutMs: 150,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "vcs_error",
    );
  }, 20_000);
});

describe("a redirected toplevel is refused, never persisted", () => {
  it("refuses a sibling redirect with root_mismatch", async () => {
    // Attaching this would persist a `canonical_root` naming a tree the operator never supplied.
    // The target self-reports honestly, so containment is what refuses it.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.siblingRedirectRoot),
      "root_mismatch",
    );
  });

  it("refuses an ancestor redirect with root_mismatch", async () => {
    // The supplied path sits inside the reported root, so containment passes; persisting it would
    // widen the mount's trust envelope (`core.worktree=/` is the limit). The self-report check
    // refuses it, because a parent directory does not report itself as a toplevel.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.ancestorRedirectRoot),
      "root_mismatch",
    );
  });
});

describe("root verification", () => {
  it("refuses an ancestor root that does not report itself", async () => {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: directoryAnsweringExecutor(recorded, (directory: string) =>
        directory === fixtures.nestedDirectory
          ? `${fixtures.fixtureRoot}\n`
          : `${fixtures.repositoryRoot}\n`,
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "root_mismatch",
    );
    // Both spawns happened, and the second asked about the widened root.
    expect(recorded.map((invocation) => invocation.args[1])).toEqual([
      fixtures.nestedDirectory,
      fixtures.fixtureRoot,
    ]);
  });
});

describe("ambient GIT_* variables cannot redirect discovery", () => {
  it("still refuses a plain directory as not_a_git_repository with GIT_DIR exported", async () => {
    // With GIT_DIR exported, raw git answers about the ambient repository and reports the plain
    // directory as a toplevel.
    vi.stubEnv("GIT_DIR", join(fixtures.repositoryRoot, ".git"));
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });
});

// Proves the repo-root resolver returns only the absolute canonical toplevel real git reports, and
// otherwise refuses with a typed reason: incomplete input, a missing or unreadable path, damaged
// git metadata, a git that cannot run, a redirected root, or ambient GIT_* redirection.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, opendir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  posix as posixPath,
  resolve as resolvePath,
  sep,
  win32 as win32Path,
} from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RepoRootResolutionError, type RepoRootResolutionReason } from "../repo-errors.js";
import {
  GIT_FATAL_EXIT_CODE,
  RepoRootResolver,
  type GitCommandFailure,
  type GitCommandOptions,
  type GitCommandResult,
  type GitFileExecutor,
  type RepoRootResolution,
} from "../repo-root-resolver.js";
import type { DirectoryReadabilityProbe } from "../trust-envelope.js";

import { buildFixtureEnvironment, runFixtureGit } from "./workspace-test-support.js";

// Mode bits, `/bin/sh` scripts and raw git stdout need POSIX; win32 shapes are driven from POSIX by
// injecting `path.win32`.
const onPosix = describe.skipIf(process.platform === "win32");
const itOnPosix = it.skipIf(process.platform === "win32");

// Root opens a mode-`0111` or `000` directory, so those fixtures would test nothing there; each
// has a seam-driven twin that runs on every platform and uid.
const itOnPosixAsNonRoot = it.skipIf(process.platform === "win32" || process.geteuid?.() === 0);

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
  readonly regularFile: string;
  readonly bareRepository: string;
  readonly submoduleRoot: string;
  readonly submoduleNestedDirectory: string;
  readonly superprojectRoot: string;
  readonly separateGitDirRoot: string;
  readonly unreadableRepositoryRoot: string;
  readonly unreadableRepositoryNestedDirectory: string;
  readonly damagedMetadataUnreadable: string;
  readonly damagedMetadataEmpty: string;
  readonly damagedMetadataDanglingGitfile: string;
  readonly absentMetadataDanglingSymlink: string;
  readonly siblingRedirectRoot: string;
  readonly ancestorRedirectRoot: string;
  readonly missingGitExecutable: string;
  readonly nonExecutableGitFile: string;
  readonly hangingGitScript: string;
  readonly environment: NodeJS.ProcessEnv;
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

  const regularFile = join(plainDirectory, "notes.txt");
  await writeFile(regularFile, "plain directory content\n", "utf8");

  const symlinkToNestedDirectory = join(fixtureRoot, "link-to-nested");
  await symlink(nestedDirectory, symlinkToNestedDirectory);

  const bareRepository = join(fixtureRoot, "bare.git");
  await runFixtureGit(["init", "-q", repositoryRoot], environment, fixtureRoot);
  await runFixtureGit(["init", "-q", "--bare", bareRepository], environment, fixtureRoot);
  await runFixtureGit(
    ["-C", repositoryRoot, "commit", "-q", "--allow-empty", "-m", "seed"],
    environment,
    fixtureRoot,
  );

  // A submodule, where `.git` is a file. `protocol.file.allow=always` is required from git 2.38.1
  // on, or a local-path `submodule add` dies with "transport 'file' not allowed".
  const superprojectRoot = join(fixtureRoot, "superproject");
  const submoduleRoot = join(superprojectRoot, "vendor", "library");
  const submoduleNestedDirectory = join(submoduleRoot, "nested", "deep");
  await runFixtureGit(["init", "-q", superprojectRoot], environment, fixtureRoot);
  await runFixtureGit(
    ["-C", superprojectRoot, "commit", "-q", "--allow-empty", "-m", "seed"],
    environment,
    fixtureRoot,
  );
  await runFixtureGit(
    [
      "-c",
      "protocol.file.allow=always",
      "-C",
      superprojectRoot,
      "submodule",
      "add",
      "-q",
      repositoryRoot,
      "vendor/library",
    ],
    environment,
    fixtureRoot,
  );
  await mkdir(submoduleNestedDirectory, { recursive: true });

  // `--separate-git-dir` leaves the gitfile in the toplevel and sets no `core.worktree`, so git
  // self-reports: a separate git directory is not the hazard, a redirected work tree is.
  const separateGitDirRoot = join(fixtureRoot, "separate-gitdir-worktree");
  await runFixtureGit(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "separate-gitdir")}`,
      separateGitDirRoot,
    ],
    environment,
    fixtureRoot,
  );

  // A repository root that traverses but does not list (mode `0111`), with a readable nested
  // directory, so only a probe of the outgoing root refuses it. `afterAll` lifts the mode.
  const unreadableRepositoryRoot = join(fixtureRoot, "unreadable-repo");
  const unreadableRepositoryNestedDirectory = join(unreadableRepositoryRoot, "nested");
  await runFixtureGit(["init", "-q", unreadableRepositoryRoot], environment, fixtureRoot);
  await mkdir(unreadableRepositoryNestedDirectory);
  if (process.platform !== "win32") {
    await chmod(unreadableRepositoryRoot, 0o111);
  }

  // Damaged metadata that git reports with the same not-a-repository stderr as an honest
  // non-repository: an unopenable `.git`, an empty `.git`, and a dangling `gitdir:` pointer.
  const damagedMetadataUnreadable = join(fixtureRoot, "damaged-unreadable-dotgit");
  const damagedMetadataEmpty = join(fixtureRoot, "damaged-empty-dotgit");
  const damagedMetadataDanglingGitfile = join(fixtureRoot, "damaged-dangling-gitfile");
  await mkdir(join(damagedMetadataUnreadable, ".git"), { recursive: true });
  await mkdir(join(damagedMetadataEmpty, ".git"), { recursive: true });
  await mkdir(damagedMetadataDanglingGitfile, { recursive: true });
  await writeFile(
    join(damagedMetadataDanglingGitfile, ".git"),
    `gitdir: ${join(fixtureRoot, "no-such-gitdir-target")}\n`,
    "utf8",
  );
  if (process.platform !== "win32") {
    await chmod(join(damagedMetadataUnreadable, ".git"), 0o000);
  }

  // Absence control: `.git` exists as a name but names nothing. The probe must follow the link to
  // reach ENOENT; one that examined the link itself would call the metadata present.
  const absentMetadataDanglingSymlink = join(fixtureRoot, "dangling-dotgit-symlink");
  await mkdir(absentMetadataDanglingSymlink, { recursive: true });
  await symlink(
    join(fixtureRoot, "no-such-symlink-target"),
    join(absentMetadataDanglingSymlink, ".git"),
  );

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
  const nonExecutableGitFile = join(scriptDirectory, "not-executable-git");
  await writeFile(nonExecutableGitFile, "#!/bin/sh\necho nope\n", "utf8");
  await chmod(nonExecutableGitFile, 0o644);

  const hangingGitScript = join(scriptDirectory, "hanging-git");
  await writeFile(hangingGitScript, "#!/bin/sh\nexec sleep 30\n", "utf8");
  await chmod(hangingGitScript, 0o755);

  fixtures = {
    fixtureRoot,
    repositoryRoot,
    nestedDirectory,
    symlinkToNestedDirectory,
    plainDirectory,
    regularFile,
    bareRepository,
    submoduleRoot,
    submoduleNestedDirectory,
    superprojectRoot,
    separateGitDirRoot,
    unreadableRepositoryRoot,
    unreadableRepositoryNestedDirectory,
    damagedMetadataUnreadable,
    damagedMetadataEmpty,
    damagedMetadataDanglingGitfile,
    absentMetadataDanglingSymlink,
    siblingRedirectRoot,
    ancestorRedirectRoot,
    missingGitExecutable: join(scriptDirectory, "definitely-not-a-git-binary"),
    nonExecutableGitFile,
    hangingGitScript,
    environment,
  };
}, 120_000);

afterAll(async () => {
  if (fixtures !== undefined) {
    // `rm` cannot descend into a `0111` or `000` directory; best-effort so a teardown failure
    // cannot mask a test failure.
    for (const unopenableDirectory of [
      fixtures.unreadableRepositoryRoot,
      join(fixtures.damagedMetadataUnreadable, ".git"),
    ]) {
      await chmod(unopenableDirectory, 0o755).catch(() => undefined);
    }
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface RawGitOutcome {
  readonly stderr: string;
  readonly exitCode: unknown;
}

/** Runs git directly and resolves with its exit code, for premises about git's own verdict. */
function runGitDirectly(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<RawGitOutcome> {
  return new Promise<RawGitOutcome>((resolve) => {
    execFile(
      "git",
      [...args],
      { encoding: "utf8", env: environment, timeout: 30_000 },
      (error, _stdout, stderr) => {
        resolve({ stderr, exitCode: error === null ? 0 : (error as { code?: unknown }).code });
      },
    );
  });
}

/** A rejection shaped like `execFile`'s, for shapes real git cannot be made to emit on demand. */
function syntheticGitFailure(shape: Partial<GitCommandFailure>): GitCommandFailure {
  return Object.assign(new Error("synthetic git failure"), shape);
}

/** Real git's not-a-repository stderr, verbatim (git 2.50, `LC_ALL=C`). */
const REAL_NOT_A_REPOSITORY_STDERR =
  "fatal: not a git repository (or any of the parent directories): .git\n";

function rejectingExecutor(failure: unknown): GitFileExecutor {
  return () => Promise.reject(failure);
}

function succeedingExecutor(stdout: string): GitFileExecutor {
  return () => Promise.resolve({ stdout, stderr: "" });
}

const alwaysReadableProbe: DirectoryReadabilityProbe = () => Promise.resolve();

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

  it("resolves a path inside a submodule to the SUBMODULE root, not the superproject", async () => {
    // A submodule is its own repository. Answering with the superproject would put the mount's
    // trust envelope around a wider tree than was attached.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.submoduleNestedDirectory,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.submoduleRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toBe(fixtures.superprojectRoot);
  });

  it("refuses a plain directory with not_a_git_repository", async () => {
    // git's positive verdict on a directory with no `.git` entry; the only route to
    // `not_a_git_repository`.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });

  it("returns an absolute root for every accepted input shape", async () => {
    const resolver = new RepoRootResolver();
    for (const input of [
      fixtures.nestedDirectory,
      fixtures.repositoryRoot,
      fixtures.symlinkToNestedDirectory,
      fixtures.submoduleNestedDirectory,
    ]) {
      const resolution = await resolver.resolveCanonicalRoot(input);
      expect(isAbsolute(resolution.canonicalRoot)).toBe(true);
    }
  });

  it("refuses a bare repository as vcs_error, not as a non-repository", async () => {
    // Real git: exit 128, "this operation must be run in a work tree". A bare repository has no
    // work tree to mount, which is not the absence of a repository.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.bareRepository),
      "vcs_error",
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

  it("never returns the daemon-cwd-resolved root for a relative input", async () => {
    // Without the gate, a daemon-side base directory would complete the relative input to a real
    // repo path and resolution would succeed, answering about whatever tree the daemon runs in.
    const relativeInput = "nested/deep";
    const settled = await new RepoRootResolver().resolveCanonicalRoot(relativeInput).then(
      (value: RepoRootResolution) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, value: error }),
    );
    expect(settled.resolved).toBe(false);
    // With the gate removed, `nested/deep` would still reject as `path_not_found` against the
    // process cwd, so the reason is what makes a bypassed gate fail.
    expect(settled.value).toBeInstanceOf(RepoRootResolutionError);
    expect((settled.value as RepoRootResolutionError).reason).toBe("not_absolute");
    // Negative control: completed against a fixture repo as base directory, the same input
    // resolves, so the refusal above is real.
    const baseCompletedRoot = await new RepoRootResolver().resolveCanonicalRoot(
      resolvePath(fixtures.repositoryRoot, relativeInput),
    );
    expect(baseCompletedRoot).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(JSON.stringify(settled.value)).not.toContain(baseCompletedRoot.canonicalRoot);
  });

  it("refuses a `~`-prefixed path with not_absolute — loudly, not by accident", async () => {
    // `~` is never expanded. Without the gate the filesystem would be asked for a literal
    // directory of that name, and a machine that had one would resolve.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot("~/some-repo"),
      "not_absolute",
    );
  });

  it("refuses the empty path as not_absolute", async () => {
    await expectResolutionFailure(new RepoRootResolver().resolveCanonicalRoot(""), "not_absolute");
  });

  it("never spawns git for a non-absolute input", async () => {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: directoryAnsweringExecutor(recorded, () => `${fixtures.repositoryRoot}\n`),
    });
    await expectResolutionFailure(resolver.resolveCanonicalRoot("src/workspace"), "not_absolute");
    expect(recorded).toHaveLength(0);
  });
});

describe("win32 driveless roots are refused, complete roots admitted", () => {
  // A full successful resolution cannot be asserted with `path.win32` on a POSIX runner, so an
  // admitted input is pinned by how it fails later: `path_not_found` from `realpath` means the
  // gate passed it through.

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

  it("never spawns git for a driveless win32 root", async () => {
    const recorded: RecordedInvocation[] = [];
    await expectResolutionFailure(
      new RepoRootResolver({
        platformPath: win32Path,
        executeFile: directoryAnsweringExecutor(recorded, () => `${fixtures.repositoryRoot}\n`),
      }).resolveCanonicalRoot(String.raw`\repos\foo`),
      "not_absolute",
    );
    expect(recorded).toHaveLength(0);
  });

  it("refuses the forward-slash spelling of the same driveless root", async () => {
    // Windows accepts `/` as a separator, so this is the identical shape.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot("/repos/foo"),
      "not_absolute",
    );
  });

  it("refuses a drive-RELATIVE path", async () => {
    // `C:foo` is relative to the current directory on drive C.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot("C:foo"),
      "not_absolute",
    );
  });

  it("admits a drive-absolute path with a backslash separator", async () => {
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(String.raw`C:\repos`),
      "path_not_found",
    );
  });

  it("admits a drive-absolute path with a forward-slash separator", async () => {
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot("C:/repos"),
      "path_not_found",
    );
  });

  itOnPosix("admits a UNC share path", async () => {
    // A UNC root names a complete location without a drive letter. POSIX-only: a Windows host
    // would try the network name and fail with an errno that maps to `not_readable`.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\\server\share\repo`,
      ),
      "path_not_found",
    );
  });

  itOnPosix("keeps the root-length rule win32-only — a POSIX `/` root stays complete", async () => {
    // POSIX `/` parses to a root of length 1, like the refused win32 `\`; applied on both
    // platforms, the length test would refuse every absolute POSIX path.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: posixPath }).resolveCanonicalRoot(
        join(fixtures.fixtureRoot, "no-such-directory"),
      ),
      "path_not_found",
    );
    const resolution = await new RepoRootResolver({
      platformPath: posixPath,
    }).resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });
});

describe("explicit failure on an unusable path", () => {
  it("throws path_not_found for a nonexistent path", async () => {
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(join(fixtures.fixtureRoot, "no-such-directory")),
      "path_not_found",
    );
  });

  it("throws not_readable when the path cannot be traversed", async () => {
    // Driven through the seam, not `chmod 000`: a permission fixture is a no-op under root, as CI
    // containers commonly run.
    const resolver = new RepoRootResolver({
      realpath: () =>
        Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "not_readable",
    );
  });

  itOnPosixAsNonRoot("throws not_readable when the git-reported ROOT does not list", async () => {
    // The supplied path is a readable nested directory, so only a probe of the reported toplevel
    // refuses. The control comes first: git never lists the toplevel, so discovery succeeds.
    const discovered = await runFixtureGit(
      ["-C", fixtures.unreadableRepositoryNestedDirectory, "rev-parse", "--show-toplevel"],
      fixtures.environment,
      fixtures.fixtureRoot,
    );
    expect(discovered.trim()).toBe(fixtures.unreadableRepositoryRoot);

    const suppliedPathHandle = await opendir(fixtures.unreadableRepositoryNestedDirectory);
    await suppliedPathHandle.close();

    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.unreadableRepositoryNestedDirectory),
      "not_readable",
    );
  });

  it("maps a probe EACCES on the outgoing root to not_readable", async () => {
    // Seam-driven twin of the fixture case above; it runs on every platform and uid.
    const resolver = new RepoRootResolver({
      probeDirectoryReadable: () =>
        Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "not_readable",
    );
  });

  it("maps a probe ENOENT on the outgoing root to path_not_found", async () => {
    // The root vanished between discovery and the gate: a missing path, not a VCS failure.
    const resolver = new RepoRootResolver({
      probeDirectoryReadable: () =>
        Promise.reject(Object.assign(new Error("no such file or directory"), { code: "ENOENT" })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "path_not_found",
    );
  });
});

describe("damaged repository metadata is vcs_error, never not_a_git_repository", () => {
  it("refuses a directory whose `.git` is an EMPTY directory", async () => {
    // Nothing is unreadable: the probe opens the metadata directory, so the reason is `vcs_error`.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.damagedMetadataEmpty),
      "vcs_error",
    );
  });

  it("refuses a `.git` gitfile whose `gitdir:` target does not exist", async () => {
    // The premise is verified inline: the shape must reach the not-a-repository arm for the gate
    // to be what refuses it.
    const rawGitOutcome = await runGitDirectly(
      ["-C", fixtures.damagedMetadataDanglingGitfile, "rev-parse", "--show-toplevel"],
      fixtures.environment,
    );
    expect(rawGitOutcome.exitCode).toBe(GIT_FATAL_EXIT_CODE);
    expect(rawGitOutcome.stderr).toMatch(/^fatal: not a git repository/im);

    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.damagedMetadataDanglingGitfile),
      "vcs_error",
    );
  });

  itOnPosixAsNonRoot("refuses a checkout whose `.git` directory cannot be opened", async () => {
    const rawGitOutcome = await runGitDirectly(
      ["-C", fixtures.damagedMetadataUnreadable, "rev-parse", "--show-toplevel"],
      fixtures.environment,
    );
    expect(rawGitOutcome.exitCode).toBe(GIT_FATAL_EXIT_CODE);
    expect(rawGitOutcome.stderr).toMatch(/^fatal: not a git repository/im);

    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.damagedMetadataUnreadable),
      "vcs_error",
    );
  });

  it("classifies a `.git` symlink that points nowhere as absence, not damage", async () => {
    // The premise first: git reads this as absence too, in the generic wording an honest
    // non-repository gets.
    const rawGitOutcome = await runGitDirectly(
      ["-C", fixtures.absentMetadataDanglingSymlink, "rev-parse", "--show-toplevel"],
      fixtures.environment,
    );
    expect(rawGitOutcome.exitCode).toBe(GIT_FATAL_EXIT_CODE);
    expect(rawGitOutcome.stderr).toMatch(
      /^fatal: not a git repository \(or any of the parent directories\)/im,
    );

    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.absentMetadataDanglingSymlink),
      "not_a_git_repository",
    );
  });

  it("reads ENOENT on the `.git` path as absence, through the seam", async () => {
    // What a genuine non-repository presents; it must still be `not_a_git_repository`.
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stdout: "",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
      probeDirectoryReadable: (path: string) =>
        path.endsWith(`${sep}.git`)
          ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          : Promise.resolve(),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });

  it("reads a SUCCESSFUL open of the `.git` path as presence, through the seam", async () => {
    // For `finish` a resolving probe is a pass; here it means damaged metadata.
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stdout: "",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
      probeDirectoryReadable: alwaysReadableProbe,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
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

  it("surfaces vcs_error when the git file is not executable", async () => {
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.nonExecutableGitFile,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
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

describe("fail-closed not-a-repository classification", () => {
  it("refuses the verdict when the marker sits inside a quoted path, not at line start", async () => {
    // A directory can be named "not a git repository"; without the line anchor its own error
    // message would be read as git's verdict.
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stderr:
            "fatal: cannot change to '/srv/fatal: not a git repository/inner': Not a directory\n",
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses the verdict on an exit code other than 128 (exit-code drift)", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({ code: 1, stderr: REAL_NOT_A_REPOSITORY_STDERR }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses the verdict on different exit-128 wording (message drift)", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stderr: "fatal: detected dubious ownership in repository at '/srv/repo'\n",
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses the verdict when the process was killed, exit code notwithstanding", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          killed: true,
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses the verdict when the process died on a signal", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          signal: "SIGTERM",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses the verdict when stderr is missing entirely", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(syntheticGitFailure({ code: GIT_FATAL_EXIT_CODE })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });
});

describe("malformed git success", () => {
  it("refuses an empty toplevel", async () => {
    const resolver = new RepoRootResolver({ executeFile: succeedingExecutor("\n") });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses a relative toplevel", async () => {
    // `.` resolves against the daemon's own working directory, so only the completeness gate stops
    // it from becoming a guessed root.
    const resolver = new RepoRootResolver({ executeFile: succeedingExecutor(".\n") });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses a toplevel that cannot itself be resolved", async () => {
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${join(fixtures.fixtureRoot, "vanished-root")}\n`),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });
});

describe("a redirected toplevel is refused, never persisted", () => {
  itOnPosix("negative control — raw git IS redirected by a repo's own core.worktree", async () => {
    // Proves the hazard reproduces on this host's git; otherwise the refusals below could pass
    // because git stopped honoring `core.worktree`. POSIX-only: it reads raw git stdout.
    const redirected = await runFixtureGit(
      ["-C", fixtures.siblingRedirectRoot, "rev-parse", "--show-toplevel"],
      fixtures.environment,
      fixtures.fixtureRoot,
    );
    expect(redirected.trim()).toBe(fixtures.repositoryRoot);
    expect(redirected.trim()).not.toBe(fixtures.siblingRedirectRoot);
  });

  itOnPosix("mirror control — command-scope core.worktree does NOT redirect", async () => {
    // Neither `git -c` nor `GIT_CONFIG_COUNT` pairs move the toplevel, so the resolver's
    // environment strip is defense in depth and the two verification checks close the vector.
    const commandScopeInjections = [
      {
        label: "git -c",
        leadingArgs: ["-c", `core.worktree=${fixtures.plainDirectory}`],
        environment: fixtures.environment,
      },
      {
        label: "GIT_CONFIG_COUNT pairs",
        leadingArgs: [],
        environment: {
          ...fixtures.environment,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.worktree",
          GIT_CONFIG_VALUE_0: fixtures.plainDirectory,
        },
      },
    ];
    for (const injection of commandScopeInjections) {
      const injected = await runFixtureGit(
        [...injection.leadingArgs, "-C", fixtures.repositoryRoot, "rev-parse", "--show-toplevel"],
        injection.environment,
        fixtures.fixtureRoot,
      );
      expect(injected.trim(), injection.label).toBe(fixtures.repositoryRoot);
    }
  });

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

  it("accepts a --separate-git-dir repository whose gitfile sits in its toplevel", async () => {
    // The boundary of the refusal: `--separate-git-dir` sets no `core.worktree`, so this
    // self-reports and resolves.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.separateGitDirRoot,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.separateGitDirRoot, vcsType: "git" });
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

describe("no unresolved or guessed root ever escapes", () => {
  it("rejects — never resolves — for every failing input shape", async () => {
    const failingCases: ReadonlyArray<{
      readonly label: string;
      readonly resolver: RepoRootResolver;
      readonly input: string;
    }> = [
      { label: "non-absolute path", resolver: new RepoRootResolver(), input: "src/workspace" },
      {
        label: "driveless win32 root",
        resolver: new RepoRootResolver({ platformPath: win32Path }),
        input: String.raw`\repos\foo`,
      },
      {
        label: "nonexistent path",
        resolver: new RepoRootResolver(),
        input: join(fixtures.fixtureRoot, "absent"),
      },
      { label: "regular file", resolver: new RepoRootResolver(), input: fixtures.regularFile },
      {
        label: "bare repository",
        resolver: new RepoRootResolver(),
        input: fixtures.bareRepository,
      },
      {
        label: "missing git binary",
        resolver: new RepoRootResolver({ gitExecutablePath: fixtures.missingGitExecutable }),
        input: fixtures.repositoryRoot,
      },
      {
        label: "empty toplevel",
        resolver: new RepoRootResolver({ executeFile: succeedingExecutor("\n") }),
        input: fixtures.plainDirectory,
      },
      {
        label: "sibling core.worktree redirect",
        resolver: new RepoRootResolver(),
        input: fixtures.siblingRedirectRoot,
      },
      {
        label: "ancestor core.worktree redirect",
        resolver: new RepoRootResolver(),
        input: fixtures.ancestorRedirectRoot,
      },
    ];

    for (const failingCase of failingCases) {
      const settled = await failingCase.resolver.resolveCanonicalRoot(failingCase.input).then(
        (value: unknown) => ({ resolved: true, value }),
        (error: unknown) => ({ resolved: false, value: error }),
      );
      expect(settled.resolved, `${failingCase.label} must reject`).toBe(false);
      expect(settled.value).toBeInstanceOf(RepoRootResolutionError);
    }
  });
});

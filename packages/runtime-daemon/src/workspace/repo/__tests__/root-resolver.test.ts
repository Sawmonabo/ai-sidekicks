// Proves the repo-root resolver returns only roots real git reports and verifies for the supplied
// path, and otherwise refuses with a typed reason: never a root guessed from the daemon's working
// directory, a root widened by a redirect, a planted `.git` pointer taken for the repository it
// names, or "not a repository" for a git that failed.

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 as win32Path } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createGitRunner,
  type GitInvocationFailure,
  type GitRunner,
} from "../../../git/process.js";
import { RepoRootResolutionError, type RepoRootResolutionReason } from "../errors.js";
import { GIT_FATAL_EXIT_CODE, RepoRootResolver } from "../root-resolver.js";

import { buildFixtureEnvironment, runFixtureGit } from "../../../git/__fixtures__/command.js";

const onPosix = process.platform !== "win32";
// Root opens a mode-`000` directory, so that fixture would test nothing there.
const canMakeUnopenable = onPosix && process.geteuid?.() !== 0;

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
  readonly separateGitDirRoot: string;
  /** A linked worktree of `repo`, which git lists. */
  readonly linkedWorktreeRoot: string;
  /** A folder whose `.git` file names `repo`'s git directory; git does not list it. */
  readonly plantedPointerHolder: string;
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

  // A submodule, where `.git` is a file. Without `protocol.file.allow=always` a local-path
  // `submodule add` is refused.
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

  const linkedWorktreeRoot = join(fixtureRoot, "linked-worktree");
  await runFixtureGit(
    ["-C", repositoryRoot, "worktree", "add", "-q", "-b", "linked", linkedWorktreeRoot],
    environment,
    fixtureRoot,
  );
  const plantedPointerHolder = join(fixtureRoot, "planted-pointer-holder");
  await mkdir(plantedPointerHolder);
  await writeFile(
    join(plantedPointerHolder, ".git"),
    `gitdir: ${join(repositoryRoot, ".git")}\n`,
    "utf8",
  );

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

  // `.git` exists as a name but names nothing: absence, which a probe reaches only by following
  // the link.
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
    separateGitDirRoot,
    linkedWorktreeRoot,
    plantedPointerHolder,
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
    // `rm` cannot descend into a `000` directory; best-effort so a teardown failure cannot mask
    // a test failure.
    await chmod(join(fixtures.damagedMetadataUnreadable, ".git"), 0o755).catch(() => undefined);
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A rejection shaped like `execFile`'s, for shapes real git cannot be made to emit on demand. */
function rejectingGit(shape: Partial<GitInvocationFailure>): GitRunner {
  return () => Promise.reject(Object.assign(new Error("synthetic git failure"), shape));
}

function succeedingGit(stdout: string): GitRunner {
  return () => Promise.resolve({ stdout: Buffer.from(stdout, "utf8"), stderr: "" });
}

function rejectingWithErrno(code: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(new Error(code), { code }));
}

/** Real git's not-a-repository stderr, verbatim under `LC_ALL=C`. */
const REAL_NOT_A_REPOSITORY_STDERR =
  "fatal: not a git repository (or any of the parent directories): .git\n";

/** Asserts the rejection is the typed carrier with the expected reason. */
async function expectResolutionFailure(
  resolving: Promise<unknown>,
  reason: RepoRootResolutionReason,
): Promise<void> {
  const thrown: unknown = await resolving.then(
    (value: unknown) => {
      throw new Error(
        `expected RepoRootResolutionError(${reason}) but resolved with ${JSON.stringify(value)}`,
      );
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(RepoRootResolutionError);
  expect(thrown).toMatchObject({ reason, code: "repo.root_resolution_failed" });
}

/** One refused input, built lazily because the fixtures exist only after `beforeAll`. */
interface RefusalCase {
  readonly refusal: string;
  readonly resolver: () => RepoRootResolver;
  readonly input: () => string;
}

const defaultResolver = (): RepoRootResolver => new RepoRootResolver();

it.each([
  { shape: "a nested subdirectory", input: "nestedDirectory", root: "repositoryRoot" },
  {
    shape: "a symlink into the repository",
    input: "symlinkToNestedDirectory",
    root: "repositoryRoot",
  },
  { shape: "the repository root", input: "repositoryRoot", root: "repositoryRoot" },
  // A submodule is its own repository: the superproject would put the mount's trust envelope
  // around a wider tree than was attached.
  { shape: "a path inside a submodule", input: "submoduleNestedDirectory", root: "submoduleRoot" },
  // `--separate-git-dir` sets no `core.worktree`, so the checkout reports itself.
  {
    shape: "a --separate-git-dir checkout",
    input: "separateGitDirRoot",
    root: "separateGitDirRoot",
  },
] as const)("resolves $shape to its own canonical toplevel", async ({ input, root }) => {
  const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures[input]);
  expect(resolution).toMatchObject({
    canonicalRoot: fixtures[root],
    workingTreeRoot: fixtures[root],
    vcsType: "git",
  });
});

describe("a `.git` pointer is believed only for a working tree git lists", () => {
  it("refuses a planted pointer as root_mismatch, while a listed worktree resolves", async () => {
    // Git answers the holder as its own top level, in the pointed-at repository; only the list
    // tells it from the linked worktree beside it.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.plantedPointerHolder),
      "root_mismatch",
    );
    expect(await new RepoRootResolver().resolveCanonicalRoot(fixtures.linkedWorktreeRoot)).toEqual({
      canonicalRoot: fixtures.repositoryRoot,
      workingTreeRoot: fixtures.linkedWorktreeRoot,
      commonDir: await realpath(join(fixtures.repositoryRoot, ".git")),
      vcsType: "git",
    });
  });
});

it("refuses a nonexistent path as path_not_found before git runs", async () => {
  // Git would answer for whatever repository holds the path's parent.
  const spawned: (readonly string[])[] = [];
  const resolver = new RepoRootResolver({
    git: (args) => {
      spawned.push(args);
      return Promise.reject(new Error("git must not run for a nonexistent path"));
    },
  });
  await expectResolutionFailure(
    resolver.resolveCanonicalRoot(join(fixtures.repositoryRoot, "no-such-directory")),
    "path_not_found",
  );
  expect(spawned).toHaveLength(0);
});

describe("an incomplete path is refused before anything resolves it", () => {
  // Completing it would take the directory or drive from the daemon's own state, not the
  // author's context.
  it.each([
    { input: "src/workspace", platformPath: undefined },
    { input: "nested/deep", platformPath: undefined },
    { input: "~/some-repo", platformPath: undefined },
    { input: "", platformPath: undefined },
    { input: String.raw`\repos\foo`, platformPath: win32Path },
    { input: "/repos/foo", platformPath: win32Path },
    { input: "C:foo", platformPath: win32Path },
  ])("refuses $input as not_absolute without spawning git", async ({ input, platformPath }) => {
    const spawned: (readonly string[])[] = [];
    const resolver = new RepoRootResolver({
      ...(platformPath === undefined ? {} : { platformPath }),
      git: (args) => {
        spawned.push(args);
        return Promise.reject(new Error("git must not run for an incomplete path"));
      },
    });
    await expectResolutionFailure(resolver.resolveCanonicalRoot(input), "not_absolute");
    expect(spawned).toHaveLength(0);
  });

  it("admits complete win32 roots", async () => {
    // `path_not_found` from `realpath` shows the gate let the input through. A UNC root is
    // checked only off Windows, where a real host would try the network name instead.
    const completeRoots = [
      String.raw`C:\repos`,
      "C:/repos",
      ...(onPosix ? [String.raw`\\server\share\repo`] : []),
    ];
    for (const input of completeRoots) {
      await expectResolutionFailure(
        new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(input),
        "path_not_found",
      );
    }
  });
});

const unusablePathCases: readonly (RefusalCase & { readonly reason: RepoRootResolutionReason })[] =
  [
    {
      refusal: "a regular file",
      resolver: defaultResolver,
      input: () => fixtures.regularFile,
      reason: "vcs_error",
    },
    {
      refusal: "a path that cannot be traversed",
      resolver: () => new RepoRootResolver({ realpath: rejectingWithErrno("EACCES") }),
      input: () => fixtures.repositoryRoot,
      reason: "not_readable",
    },
    {
      refusal: "a reported root that cannot be listed",
      resolver: () =>
        new RepoRootResolver({ probeDirectoryReadable: rejectingWithErrno("EACCES") }),
      input: () => fixtures.repositoryRoot,
      reason: "not_readable",
    },
    {
      refusal: "a reported root that vanished before the gate",
      resolver: () =>
        new RepoRootResolver({ probeDirectoryReadable: rejectingWithErrno("ENOENT") }),
      input: () => fixtures.repositoryRoot,
      reason: "path_not_found",
    },
  ];

it.each(unusablePathCases)("refuses $refusal as $reason", async ({ resolver, input, reason }) => {
  await expectResolutionFailure(resolver().resolveCanonicalRoot(input()), reason);
});

describe("not_a_repository is git's own verdict on absent metadata, and nothing else", () => {
  it.each([
    { absence: "a plain directory", input: "plainDirectory", ambientGitDir: false },
    {
      absence: "a `.git` symlink that points nowhere",
      input: "absentMetadataDanglingSymlink",
      ambientGitDir: false,
    },
    // With GIT_DIR exported, raw git answers about the ambient repository instead.
    {
      absence: "a plain directory with GIT_DIR exported",
      input: "plainDirectory",
      ambientGitDir: true,
    },
  ] as const)("reads $absence as not_a_repository", async ({ input, ambientGitDir }) => {
    if (ambientGitDir) {
      vi.stubEnv("GIT_DIR", join(fixtures.repositoryRoot, ".git"));
    }
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures[input]),
      "not_a_repository",
    );
  });

  // Damaged metadata draws the same stderr as an honest non-repository, and a git that cannot run
  // says nothing about the path; reading either as "not a repository" misreports a real one.
  const plainDirectory = (): string => fixtures.plainDirectory;
  const synthetic = (shape: Partial<GitInvocationFailure>) => (): RepoRootResolver =>
    new RepoRootResolver({ git: rejectingGit(shape) });
  const vcsErrorCases: readonly RefusalCase[] = [
    {
      refusal: "an empty `.git` directory",
      resolver: defaultResolver,
      input: () => fixtures.damagedMetadataEmpty,
    },
    {
      refusal: "a `gitdir:` pointer to nothing",
      resolver: defaultResolver,
      input: () => fixtures.damagedMetadataDanglingGitfile,
    },
    ...(canMakeUnopenable
      ? [
          {
            refusal: "a `.git` directory that cannot be opened",
            resolver: defaultResolver,
            input: () => fixtures.damagedMetadataUnreadable,
          },
        ]
      : []),
    {
      refusal: "a bare repository",
      resolver: defaultResolver,
      input: () => fixtures.bareRepository,
    },
    {
      refusal: "a missing git executable",
      resolver: () => new RepoRootResolver({ git: createGitRunner(fixtures.missingGitExecutable) }),
      input: () => fixtures.nestedDirectory,
    },
    {
      // No git along the login shell's PATH: the daemon starts, and the first resolution refuses.
      refusal: "no git found at start",
      resolver: () => new RepoRootResolver({ git: createGitRunner(undefined) }),
      input: () => fixtures.nestedDirectory,
    },
    {
      refusal: "a git file that is not executable",
      resolver: () => new RepoRootResolver({ git: createGitRunner(fixtures.nonExecutableGitFile) }),
      input: () => fixtures.repositoryRoot,
    },
    ...(onPosix
      ? [
          {
            refusal: "a git that outlives its timeout",
            resolver: () =>
              new RepoRootResolver({
                git: createGitRunner(fixtures.hangingGitScript),
                gitCommandTimeoutMs: 150,
              }),
            input: () => fixtures.repositoryRoot,
          },
        ]
      : []),
    {
      // A directory can be named "not a git repository"; only a line-start marker is git's verdict.
      refusal: "the marker inside a quoted path",
      resolver: synthetic({
        code: GIT_FATAL_EXIT_CODE,
        stderr:
          "fatal: cannot change to '/srv/fatal: not a git repository/inner': Not a directory\n",
      }),
      input: plainDirectory,
    },
    {
      refusal: "an exit code other than 128",
      resolver: synthetic({ code: 1, stderr: REAL_NOT_A_REPOSITORY_STDERR }),
      input: plainDirectory,
    },
    {
      refusal: "other exit-128 wording",
      resolver: synthetic({
        code: GIT_FATAL_EXIT_CODE,
        stderr: "fatal: detected dubious ownership in repository at '/srv/repo'\n",
      }),
      input: plainDirectory,
    },
    {
      refusal: "a killed process",
      resolver: synthetic({
        code: GIT_FATAL_EXIT_CODE,
        killed: true,
        stderr: REAL_NOT_A_REPOSITORY_STDERR,
      }),
      input: plainDirectory,
    },
    {
      refusal: "a process that died on a signal",
      resolver: synthetic({
        code: GIT_FATAL_EXIT_CODE,
        signal: "SIGTERM",
        stderr: REAL_NOT_A_REPOSITORY_STDERR,
      }),
      input: plainDirectory,
    },
    {
      refusal: "a failure with no stderr",
      resolver: synthetic({ code: GIT_FATAL_EXIT_CODE }),
      input: plainDirectory,
    },
  ];

  it.each(vcsErrorCases)(
    "reads $refusal as vcs_error",
    { timeout: 20_000 },
    async ({ resolver, input }) => {
      await expectResolutionFailure(resolver().resolveCanonicalRoot(input()), "vcs_error");
    },
  );
});

describe("a root git did not report for the supplied path is never returned", () => {
  const redirectCases: readonly (RefusalCase & { readonly reason: RepoRootResolutionReason })[] = [
    {
      refusal: "an empty toplevel",
      resolver: () => new RepoRootResolver({ git: succeedingGit("\n") }),
      input: () => fixtures.plainDirectory,
      reason: "vcs_error",
    },
    {
      // `.` would resolve against the daemon's own working directory.
      refusal: "a relative toplevel",
      resolver: () => new RepoRootResolver({ git: succeedingGit(".\n") }),
      input: () => fixtures.plainDirectory,
      reason: "vcs_error",
    },
    {
      refusal: "a toplevel that does not resolve",
      resolver: () =>
        new RepoRootResolver({
          git: succeedingGit(`${join(fixtures.fixtureRoot, "vanished-root")}\n`),
        }),
      input: () => fixtures.plainDirectory,
      reason: "vcs_error",
    },
    {
      // A repository's own `core.worktree` points at another tree, which reports itself honestly;
      // containment refuses it.
      refusal: "a sibling core.worktree redirect",
      resolver: defaultResolver,
      input: () => fixtures.siblingRedirectRoot,
      reason: "root_mismatch",
    },
    {
      // Pointed at the supplied path's parent, which would widen the trust envelope
      // (`core.worktree=/` is the limit); the parent does not report itself as a toplevel.
      refusal: "an ancestor core.worktree redirect",
      resolver: defaultResolver,
      input: () => fixtures.ancestorRedirectRoot,
      reason: "root_mismatch",
    },
  ];

  it.each(redirectCases)("refuses $refusal as $reason", async ({ resolver, input, reason }) => {
    await expectResolutionFailure(resolver().resolveCanonicalRoot(input()), reason);
  });
});

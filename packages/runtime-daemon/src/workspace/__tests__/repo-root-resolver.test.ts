// repo-root-resolver.test.ts: resolution, classification and fail-closed pins for the canonical
// repo-root resolver.
//
// * Every non-resolution rejects with a typed, path-free `RepoRootResolutionError`; no call
//   returns a partial or guessed root, including one completed from the daemon's own state: a
//   relative path from its working directory, `~` from its home, a driveless Windows root from its
//   current drive.
// * `not_a_git_repository` is reported only on a positive not-a-repository verdict from git
//   itself; a missing, non-executable, killed, or otherwise broken git is `vcs_error`.
//
// Real git runs against real temp directories for every shape it can produce: a nested
// subdirectory, a symlink, a plain directory, the three shapes where `.git` is a file (linked
// worktree, submodule, `--separate-git-dir`), a bare repository, a regular file, and both
// `core.worktree` redirect shapes, where real git answers with a tree the caller never named. The
// injected executor covers only shapes real git cannot be made to emit on demand (wording or
// exit-code drift, a killed process that still carries an exit code, a root that reports one thing
// and then another) and argv or environment inspection. The missing-git case uses the real
// `execFile` with `gitExecutablePath` pointing at a nonexistent file, so it discriminates Node's
// own `ENOENT`.
//
// `platformPath` makes platform shapes testable: injecting `path.win32` drives the resolver's
// Windows branch on a POSIX runner, so the driveless-root refusal is asserted in CI.
//
// `probeDirectoryReadable` is driven mostly by real fixtures (the `0111` root that traverses but
// does not list, the three damaged-metadata shapes, and the dangling `.git` symlink as their
// absence-side control). It is injected for resolved roots that exist nowhere on the host, for
// `finish`'s errno mapping, and for the metadata gate's two readings. Those are different
// mappings, and a stub written for one misleads the other: `finish` classifies a rejection into a
// resolution failure, while the not-a-repository arm's metadata gate reads `ENOENT` as absence
// (`not_a_git_repository`) and a successful open as damage (`vcs_error`). A mode bit is a no-op
// under root, so each mode-dependent fixture case has a seam-driven twin that runs everywhere.
//
// Fixture git runs under a hermetic environment (`GIT_CONFIG_NOSYSTEM`, `HOME`, `XDG_CONFIG_HOME`
// and `GIT_CONFIG_GLOBAL` inside the temp root, explicit identity) so a developer's git config
// cannot change what the tests observe. The resolver's environment differs on purpose: it trusts
// an operator's own config redirection as it trusts `PATH`, and strips only the discovery
// redirectors and the two config-injection channels (`GIT_CONFIG_COUNT`,
// `GIT_CONFIG_PARAMETERS`). It is asserted separately below.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
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
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_EXECUTABLE,
  DEFAULT_REALPATH,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  GIT_FATAL_EXIT_CODE,
  GIT_STDIO_MAX_BUFFER_BYTES,
  RepoRootResolver,
  type GitCommandFailure,
  type RepoRootResolution,
  type GitCommandOptions,
  type GitCommandResult,
  type GitFileExecutor,
  type PlatformPathModule,
} from "../repo-root-resolver.js";
// The probe type has one declaration, shared with the resolver.
import type { DirectoryReadabilityProbe } from "../trust-envelope.js";

// Windows path handling is covered from POSIX by injecting `path.win32`, so only cases that need
// POSIX itself (mode bits, `\r` in names, `/bin/sh` scripts) are skipped on Windows. CI runs the
// daemon tests on ubuntu only, so those skips never fire there today.
const onPosix = describe.skipIf(process.platform === "win32");
const itOnPosix = it.skipIf(process.platform === "win32");

/**
 * POSIX and not running as root: the gate for permission-mode fixtures. Root opens a `0111`
 * directory, so those cases would pass while testing nothing; each has a seam-driven twin that
 * runs on every platform and uid.
 */
const itOnPosixAsNonRoot = it.skipIf(process.platform === "win32" || process.geteuid?.() === 0);

/**
 * Whether the filesystem under `os.tmpdir()` is case-insensitive, probed by creating a directory
 * in one spelling and stat-ing the other.
 *
 * Probed rather than derived from `process.platform`: APFS can be formatted case-sensitive and
 * Linux can mount a case-insensitive volume. The CI test job runs on ubuntu only, so it reports
 * case-sensitive and the tests this gates skip there; the default-implementation pin below fails
 * on every platform if the realpath seam is swapped.
 */
const filesystemIsCaseInsensitive: boolean = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), "repo-root-resolver-case-probe-"));
  try {
    mkdirSync(join(probeRoot, "CaseProbe"));
    statSync(join(probeRoot, "caseprobe"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

const itOnCaseInsensitiveFilesystem = it.skipIf(!filesystemIsCaseInsensitive);

// ----------------------------------------------------------------------------
// Real-git fixtures
// ----------------------------------------------------------------------------

/**
 * Every env key the resolver strips, spelled out independently of the resolver's own list so the
 * set-equality test below has two sides to compare. Five are direct discovery redirectors;
 * `GIT_OBJECT_DIRECTORY` bends what git accepts as a repository, in both directions;
 * `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` are the two separate config-injection channels,
 * stripped as defense in depth.
 */
const EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

/**
 * The environment fixture git runs under: no system or global config, a `HOME` inside the temp
 * root, and an explicit identity so the seed commit needs no host `user.name`. Not the resolver's
 * environment, which is production-shaped.
 */
function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
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

interface RawGitOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: unknown;
}

/** Runs git directly — fixture construction and the negative controls. */
function runGitDirectly(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<RawGitOutcome> {
  return new Promise<RawGitOutcome>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { encoding: "utf8", env: environment, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          // A non-zero exit resolves with its code instead of rejecting: negative controls assert
          // on git's failure output, and `runGitOrThrow` turns a failed fixture command into a
          // throw.
          const exitCode: unknown = (error as { code?: unknown }).code;
          resolve({ stdout, stderr, exitCode });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    ).on("error", reject);
  });
}

async function runGitOrThrow(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<RawGitOutcome> {
  const outcome = await runGitDirectly(args, environment);
  if (outcome.exitCode !== 0) {
    throw new Error(
      `fixture git ${args.join(" ")} failed (exit ${String(outcome.exitCode)}): ${outcome.stderr}`,
    );
  }
  return outcome;
}

/** Every path the suite resolves against, all rooted in one realpath'd temp dir. */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly repositoryRoot: string;
  readonly mixedCaseRepositoryRoot: string;
  readonly nestedDirectory: string;
  readonly symlinkToNestedDirectory: string;
  readonly plainDirectory: string;
  readonly regularFile: string;
  readonly unreadableRepositoryRoot: string;
  readonly unreadableRepositoryNestedDirectory: string;
  readonly damagedMetadataUnreadable: string;
  readonly damagedMetadataEmpty: string;
  readonly damagedMetadataDanglingGitfile: string;
  readonly absentMetadataDanglingSymlink: string;
  readonly bareRepository: string;
  readonly linkedWorktreeRoot: string;
  readonly superprojectRoot: string;
  readonly submoduleRoot: string;
  readonly submoduleNestedDirectory: string;
  readonly separateGitDirRoot: string;
  readonly siblingRedirectRoot: string;
  readonly ancestorRedirectContainer: string;
  readonly ancestorRedirectRoot: string;
  readonly carriageReturnDirectory: string;
  readonly carriageReturnSiblingDirectory: string;
  readonly missingGitExecutable: string;
  readonly nonExecutableGitFile: string;
  readonly failingGitScript: string;
  readonly signalKilledGitScript: string;
  readonly hangingGitScript: string;
  readonly environment: NodeJS.ProcessEnv;
}

let fixtures: Fixtures;

/**
 * Writes an executable `/bin/sh` stand-in for git. The timeout script uses `exec` so the sleeping
 * process is the direct child: a forked grandchild would survive the kill holding the stdio
 * pipes, and `execFile`'s callback would not fire until they closed.
 */
async function writeExecutableScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

beforeAll(async () => {
  // Realpath the temp root once and derive every expected value from it: on macOS `os.tmpdir()` is
  // a symlink into `/private/var/folders/...`, which the resolver canonicalizes.
  //
  // Resolved with the module's own primitive (`node:fs/promises.realpath`, the seam default), so a
  // spelling difference cannot surface as a fixture-versus-module mismatch on macOS only.
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

  // Deliberately mixed-case, so a test can attach it under a spelling that differs only in case.
  // That spelling resolves only on a case-insensitive filesystem, which is why its test is gated
  // on the probe.
  const mixedCaseRepositoryRoot = join(fixtureRoot, "MixedCaseRepo");

  const bareRepository = join(fixtureRoot, "bare.git");
  const linkedWorktreeRoot = join(fixtureRoot, "linked-worktree");
  await runGitOrThrow(["init", "-q", repositoryRoot], environment);
  await runGitOrThrow(["init", "-q", mixedCaseRepositoryRoot], environment);
  await runGitOrThrow(["init", "-q", "--bare", bareRepository], environment);
  // Inside the linked worktree `.git` is a file, so a parent-walk for a `.git` directory would
  // find no repository.
  await runGitOrThrow(
    ["-C", repositoryRoot, "commit", "-q", "--allow-empty", "-m", "seed"],
    environment,
  );
  await runGitOrThrow(
    ["-C", repositoryRoot, "worktree", "add", "-q", "-b", "fixture-wt", linkedWorktreeRoot],
    environment,
  );

  // Submodule fixture, the second shape where `.git` is a file. `protocol.file.allow=always` is
  // required from git 2.38.1 on, or a local-path `submodule add` dies with "transport 'file' not
  // allowed" (exit 128, seen on git 2.50.1). It is scoped to this one invocation over a source
  // repository inside the temp root, and older git ignores the unknown key.
  const superprojectRoot = join(fixtureRoot, "superproject");
  const submoduleRoot = join(superprojectRoot, "vendor", "library");
  const submoduleNestedDirectory = join(submoduleRoot, "nested", "deep");
  await runGitOrThrow(["init", "-q", superprojectRoot], environment);
  await runGitOrThrow(
    ["-C", superprojectRoot, "commit", "-q", "--allow-empty", "-m", "seed"],
    environment,
  );
  await runGitOrThrow(
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
  );
  // The source repository has only an empty seed commit, so the checkout is empty; the nested
  // directory makes the input a path below the submodule root.
  await mkdir(submoduleNestedDirectory, { recursive: true });

  // The third shape where `.git` is a file: `--separate-git-dir` leaves the gitfile in the
  // toplevel and sets no `core.worktree`, so git self-reports and root verification passes. It
  // shows that separate git directories are not refused, only a work tree pointed elsewhere.
  const separateGitDirRoot = join(fixtureRoot, "separate-gitdir-worktree");
  await runGitOrThrow(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "separate-gitdir")}`,
      separateGitDirRoot,
    ],
    environment,
  );

  // Redirect fixtures: a repository whose own config sets `core.worktree`, which moves
  // `--show-toplevel`. The gitfile shape makes that config reachable without owning the tree it
  // names. In git 2.50.1 `core.worktree` in the repository's config redirects where the
  // command-scope channels do not; controls below pin both halves. One fixture per verification
  // check, because neither check catches both shapes.
  //
  // Sibling: pointed at the fixture repository rather than an inert directory. A real repository
  // self-reports, so only containment refuses this shape.
  const siblingRedirectRoot = join(fixtureRoot, "sibling-redirect");
  await runGitOrThrow(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "sibling-redirect-gitdir")}`,
      siblingRedirectRoot,
    ],
    environment,
  );
  await runGitOrThrow(
    ["-C", siblingRedirectRoot, "config", "core.worktree", repositoryRoot],
    environment,
  );

  // Ancestor: pointed at the attached directory's own parent, so the input sits inside the
  // reported root and containment passes. Only the self-report check refuses it, since the parent
  // does not report itself as a toplevel.
  const ancestorRedirectContainer = join(fixtureRoot, "ancestor-container");
  const ancestorRedirectRoot = join(ancestorRedirectContainer, "attached");
  await runGitOrThrow(
    [
      "init",
      "-q",
      `--separate-git-dir=${join(fixtureRoot, "ancestor-redirect-gitdir")}`,
      ancestorRedirectRoot,
    ],
    environment,
  );
  await runGitOrThrow(
    ["-C", ancestorRedirectRoot, "config", "core.worktree", ancestorRedirectContainer],
    environment,
  );

  // A directory whose name really ends in `\r`, beside one spelled without it. The pair makes the
  // terminator rule observable: stripping the `\r` lands on the sibling, which exists, and
  // silently returns the wrong tree.
  //
  // Created on POSIX only: NTFS forbids `\r` in names, so on Windows it would fail the whole
  // `beforeAll`.
  const carriageReturnDirectory = join(fixtureRoot, "carriage-return-root\r");
  const carriageReturnSiblingDirectory = join(fixtureRoot, "carriage-return-root");
  if (process.platform !== "win32") {
    await mkdir(carriageReturnDirectory);
    await mkdir(carriageReturnSiblingDirectory);
  }

  // A repository root that traverses but does not list (mode `0111`). Discovery never lists the
  // toplevel, so git still answers `--show-toplevel` (git 2.50.1) and reaches `finish`.
  //
  // It keeps a readable nested directory: the attached path opens fine while the resolved root
  // does not, so only a probe of the outgoing root refuses it.
  //
  // The mode is applied here so no failing assertion can leave it behind; `afterAll` lifts it
  // before the recursive delete, which cannot descend into a `0111` directory. Skipped on win32,
  // where mode bits mean something else.
  const unreadableRepositoryRoot = join(fixtureRoot, "unreadable-repo");
  const unreadableRepositoryNestedDirectory = join(unreadableRepositoryRoot, "nested");
  await runGitOrThrow(["init", "-q", unreadableRepositoryRoot], environment);
  await mkdir(unreadableRepositoryNestedDirectory);
  if (process.platform !== "win32") {
    await chmod(unreadableRepositoryRoot, 0o111);
  }

  // Damaged metadata: three directories that git reports as "not a git repository" with the
  // anchored marker at exit 128, exactly as for an honest non-repository (git 2.50.1). Stderr
  // cannot tell them apart, so without the consistency gate all three would be refused as
  // `not_a_git_repository`. Each has a `.git` entry that the gate's probe meets as EACCES, a
  // successful open, and ENOTDIR respectively.
  const damagedMetadataUnreadable = join(fixtureRoot, "damaged-unreadable-dotgit");
  const damagedMetadataEmpty = join(fixtureRoot, "damaged-empty-dotgit");
  const damagedMetadataDanglingGitfile = join(fixtureRoot, "damaged-dangling-gitfile");
  await mkdir(join(damagedMetadataUnreadable, ".git"), { recursive: true });
  await mkdir(join(damagedMetadataEmpty, ".git"), { recursive: true });
  await mkdir(damagedMetadataDanglingGitfile, { recursive: true });
  // A `gitdir:` pointer to a target that does not exist. git reports `fatal: not a git repository:
  // <target>`, which matches the marker, while the probe meets a file and gets ENOTDIR.
  await writeFile(
    join(damagedMetadataDanglingGitfile, ".git"),
    `gitdir: ${join(fixtureRoot, "no-such-gitdir-target")}\n`,
    "utf8",
  );
  // Mode `000`, not `0111`: the gate must refuse a metadata directory it cannot open. `afterAll`
  // lifts it before the recursive delete.
  if (process.platform !== "win32") {
    await chmod(join(damagedMetadataUnreadable, ".git"), 0o000);
  }

  // Absence control for those three: `.git` exists as a name but names nothing. The probe must
  // follow the link to reach ENOENT; one that examined the link itself would call the metadata
  // present and report `vcs_error` for a directory git calls a non-repository. git reads it as
  // absence too, which the test asserts before the verdict.
  const absentMetadataDanglingSymlink = join(fixtureRoot, "dangling-dotgit-symlink");
  await mkdir(absentMetadataDanglingSymlink, { recursive: true });
  await symlink(
    join(fixtureRoot, "no-such-symlink-target"),
    join(absentMetadataDanglingSymlink, ".git"),
  );

  const nonExecutableGitFile = join(scriptDirectory, "not-executable-git");
  await writeFile(nonExecutableGitFile, "#!/bin/sh\necho nope\n", "utf8");
  await chmod(nonExecutableGitFile, 0o644);

  const failingGitScript = join(scriptDirectory, "failing-git");
  const signalKilledGitScript = join(scriptDirectory, "signal-killed-git");
  const hangingGitScript = join(scriptDirectory, "hanging-git");
  await writeExecutableScript(failingGitScript, 'echo "boom: unreadable object store" >&2\nexit 1');
  await writeExecutableScript(signalKilledGitScript, "kill -9 $$");
  await writeExecutableScript(hangingGitScript, "exec sleep 30");

  fixtures = {
    fixtureRoot,
    repositoryRoot,
    mixedCaseRepositoryRoot,
    nestedDirectory,
    symlinkToNestedDirectory,
    plainDirectory,
    regularFile,
    unreadableRepositoryRoot,
    unreadableRepositoryNestedDirectory,
    damagedMetadataUnreadable,
    damagedMetadataEmpty,
    damagedMetadataDanglingGitfile,
    absentMetadataDanglingSymlink,
    bareRepository,
    linkedWorktreeRoot,
    superprojectRoot,
    submoduleRoot,
    submoduleNestedDirectory,
    separateGitDirRoot,
    siblingRedirectRoot,
    ancestorRedirectContainer,
    ancestorRedirectRoot,
    carriageReturnDirectory,
    carriageReturnSiblingDirectory,
    missingGitExecutable: join(scriptDirectory, "definitely-not-a-git-binary"),
    nonExecutableGitFile,
    failingGitScript,
    signalKilledGitScript,
    hangingGitScript,
    environment,
  };
}, 120_000);

afterAll(async () => {
  if (fixtures !== undefined) {
    // Lift the unopenable modes first: `rm` cannot descend into a `0111` or `000` directory, and
    // `force` suppresses ENOENT, not EACCES, so teardown would fail and strand the temp tree. The
    // restore is best-effort so a teardown failure cannot mask a real test failure.
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

// ----------------------------------------------------------------------------
// Synthetic executor doubles
// ----------------------------------------------------------------------------

interface SyntheticFailureShape {
  readonly code?: string | number | undefined;
  readonly signal?: NodeJS.Signals | undefined;
  readonly killed?: boolean | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

/**
 * A rejection shaped like `execFile`'s. The wording is what real git emits, taken from observed
 * output rather than copied from the resolver's matcher.
 */
function syntheticGitFailure(shape: SyntheticFailureShape): GitCommandFailure {
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

interface RecordedInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: GitCommandOptions;
}

/**
 * Captures every invocation and answers each with the same real toplevel. One resolution makes
 * two invocations (discovery on the input, verification on the reported root), and a constant
 * answer serves both because the self-report check needs a root that answers with itself. Cases
 * needing different answers use the directory-answering executor.
 */
function recordingExecutor(recorded: RecordedInvocation[], stdout: string): GitFileExecutor {
  return (file: string, args: readonly string[], options: GitCommandOptions) => {
    recorded.push({ file, args, options });
    return Promise.resolve<GitCommandResult>({ stdout, stderr: "" });
  };
}

/**
 * Answers each invocation from its `-C` directory (`args[1]`). Keying on the directory rather
 * than a call counter lets a case say "the input reports X, and X reports Y" without encoding the
 * resolver's call order.
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

/**
 * Answers the discovery query, then fails the verification query. The one double keyed on call
 * order, because its cases are about the second spawn failing.
 */
function failingVerificationExecutor(
  discoveryStdout: string,
  verificationFailure: unknown,
): GitFileExecutor {
  let invocationCount = 0;
  return () => {
    invocationCount += 1;
    if (invocationCount === 1) {
      return Promise.resolve<GitCommandResult>({ stdout: discoveryStdout, stderr: "" });
    }
    return Promise.reject(verificationFailure);
  };
}

/**
 * A readability probe that always succeeds, for the two trailing-space-name cases whose synthetic
 * resolved root exists nowhere on the host. Every other successful resolution lands on a real
 * fixture and keeps the real probe.
 */
const alwaysReadableProbe: DirectoryReadabilityProbe = () => Promise.resolve();

/**
 * Asserts the rejection is the typed carrier with the expected reason. `reason` takes the full
 * union, so a new member needs no edit here.
 */
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

  it("resolves the repository root itself to the same value", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    // The persisted root carries the filesystem's own casing for every component, so two attaches
    // of one repository get the same `canonical_root`.
    expect(resolution.canonicalRoot).toBe(realpathSync.native(fixtures.repositoryRoot));
  });

  itOnCaseInsensitiveFilesystem(
    "accepts a mis-cased attach and persists the on-disk casing",
    async () => {
      // Containment compares component strings without case folding, so this passes only because
      // the realpath seam normalizes the input's casing before git is asked. A JS-walk realpath
      // keeps the caller's spelling, and this attach would be refused `root_mismatch`: an honest
      // repository turned away on the default macOS filesystem.
      const misCasedSpelling = join(fixtures.fixtureRoot, "mixedcaserepo");
      const resolution = await new RepoRootResolver().resolveCanonicalRoot(misCasedSpelling);
      expect(resolution).toEqual({
        canonicalRoot: realpathSync.native(fixtures.mixedCaseRepositoryRoot),
        vcsType: "git",
      });
      expect(resolution.canonicalRoot).not.toBe(misCasedSpelling);
    },
  );

  it("resolves a linked worktree to the worktree root, where .git is a FILE", async () => {
    // `.git` is a file holding a `gitdir:` pointer here, so a parent-walk for a `.git` directory
    // would find nothing; `rev-parse` handles it.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.linkedWorktreeRoot,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.linkedWorktreeRoot, vcsType: "git" });
  });

  it("resolves a path inside a submodule to the SUBMODULE root, not the superproject", async () => {
    // The second shape where `.git` is a file. A submodule is its own repository, so a checkout
    // nested in one canonicalizes to the submodule root. Answering with the superproject would put
    // the mount's trust envelope around a wider tree than was attached and collide with a separate
    // attach of the superproject.
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
      fixtures.linkedWorktreeRoot,
      fixtures.submoduleNestedDirectory,
    ]) {
      const resolution = await resolver.resolveCanonicalRoot(input);
      expect(isAbsolute(resolution.canonicalRoot)).toBe(true);
    }
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

  it("hands git the realpath'd input, never the alias the caller supplied", async () => {
    // Canonicalizing before the query is what makes the symlink guarantee structural rather than a
    // side effect of git's own getcwd() behavior.
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    await resolver.resolveCanonicalRoot(fixtures.symlinkToNestedDirectory);
    // Two invocations: discovery on the realpath'd input, then verification on the root it
    // reported. Neither sees the alias.
    expect(recorded.map((invocation) => invocation.args)).toEqual([
      ["-C", fixtures.nestedDirectory, "rev-parse", "--show-toplevel"],
      ["-C", fixtures.repositoryRoot, "rev-parse", "--show-toplevel"],
    ]);
  });
});

// ----------------------------------------------------------------------------
// Absoluteness gate — the daemon never completes a path from its own state
// ----------------------------------------------------------------------------

describe("non-absolute input is refused before resolution", () => {
  // `realpath` resolves a relative path against the daemon's working directory, so the root it
  // produced would be a plausible guess from daemon state, not the author's context. These cases
  // pin the refusal and that it happens before any resolution work.

  it("refuses a bare relative path with not_absolute, not a filesystem reason", async () => {
    // `path_not_found` or `vcs_error` here would mean the gate did not fire and the input failed
    // later by luck.
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
    // The reason assertion keeps this test's mutation power: with the gate removed, `nested/deep`
    // is unresolvable against the process cwd and would still reject, as `path_not_found`. Pinning
    // `not_absolute` makes a bypassed gate fail the test.
    expect(settled.value).toBeInstanceOf(RepoRootResolutionError);
    expect((settled.value as RepoRootResolutionError).reason).toBe("not_absolute");
    // Negative control: completed against a fixture repo as base directory, the same input
    // resolves, so the refusal above is real. The base is the fixture repo, not the live checkout,
    // keeping the test hermetic (no `process.cwd()`, no ambient `GIT_*`).
    const baseCompletedRoot = await new RepoRootResolver().resolveCanonicalRoot(
      resolvePath(fixtures.repositoryRoot, relativeInput),
    );
    expect(baseCompletedRoot).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(JSON.stringify(settled.value)).not.toContain(baseCompletedRoot.canonicalRoot);
  });

  it("refuses a `~`-prefixed path with not_absolute — loudly, not by accident", async () => {
    // `~` is never expanded. Without the gate the filesystem would be asked for a literal
    // directory of that name, and a machine that had one would resolve, substituting the daemon's
    // filesystem for the author's.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot("~/some-repo"),
      "not_absolute",
    );
  });

  it("refuses a bare `~`", async () => {
    await expectResolutionFailure(new RepoRootResolver().resolveCanonicalRoot("~"), "not_absolute");
  });

  it("refuses `./`-prefixed and parent-relative forms", async () => {
    const resolver = new RepoRootResolver();
    for (const relativeInput of ["./src", "../runtime-daemon", "nested/deep"]) {
      await expectResolutionFailure(resolver.resolveCanonicalRoot(relativeInput), "not_absolute");
    }
  });

  it("refuses the empty path as not_absolute", async () => {
    // The empty string names nothing; refusing it as `not_absolute` describes the defect, where a
    // missing-path reason would not.
    await expectResolutionFailure(new RepoRootResolver().resolveCanonicalRoot(""), "not_absolute");
  });

  it("never spawns git for a non-absolute input", async () => {
    // No executor call at all: the gate precedes resolution.
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    await expectResolutionFailure(resolver.resolveCanonicalRoot("src/workspace"), "not_absolute");
    expect(recorded).toHaveLength(0);
  });

  it("carries a path-free message for not_absolute", async () => {
    const failure = await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot("private-clients/acme-payments"),
      "not_absolute",
    );
    expect(failure.message).not.toContain("acme-payments");
    expect(failure.message).not.toMatch(/[/\\]/);
    expect(JSON.stringify(failure.detail)).not.toContain("acme-payments");
  });

  it("still accepts every absolute fixture — the gate refuses only the relative", async () => {
    const resolver = new RepoRootResolver();
    for (const input of [
      fixtures.repositoryRoot,
      fixtures.nestedDirectory,
      fixtures.submoduleNestedDirectory,
    ]) {
      const resolution = await resolver.resolveCanonicalRoot(input);
      expect(isAbsolute(resolution.canonicalRoot)).toBe(true);
    }
  });
});

// ----------------------------------------------------------------------------
// win32 path shapes — the gate's Windows branch, driven from a POSIX runner
// ----------------------------------------------------------------------------

describe("win32 driveless roots are refused, complete roots admitted", () => {
  // `path.win32.isAbsolute` short-circuits on a leading separator before looking for a drive, so
  // `\repos\foo` reports absolute while naming no volume. Resolving it would take the volume from
  // the daemon's current drive: the same guessed-root defect as a relative path taking the cwd.
  //
  // Every case injects `path.win32`, except the closing scoping control, which injects
  // `path.posix`. A full successful resolution cannot be asserted here: `finish` re-checks the
  // outgoing root with the real `node:path` (a backstop for a broken seam), and no win32 path is
  // absolute to a POSIX `isAbsolute`. An admitted input is pinned by how it fails later:
  // `path_not_found` from `realpath` means the gate passed it through.

  it("refuses a backslash-rooted path that names no drive", async () => {
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\repos\foo`,
      ),
      "not_absolute",
    );
  });

  it("refuses the forward-slash spelling of the same driveless root", async () => {
    // Windows accepts `/` as a separator, so this is the identical shape.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot("/repos/foo"),
      "not_absolute",
    );
  });

  it("refuses a drive-RELATIVE path", async () => {
    // `C:foo` is relative to the current directory on drive C. `isAbsolute` already reports false;
    // this pins that the root-length rule did not admit it.
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
    // A UNC root (`\\server\share\`) names a complete location without a drive letter, which is
    // why the rule reads the parsed root's length rather than looking for `:`.
    //
    // POSIX-only: admission is read off the later `path_not_found` (ENOENT from `realpath` on a
    // POSIX host). A Windows host would try the network name, slowly, and fail with an errno that
    // maps to `not_readable`.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\\server\share\repo`,
      ),
      "path_not_found",
    );
  });

  it("never spawns git for a driveless win32 root", async () => {
    const recorded: RecordedInvocation[] = [];
    await expectResolutionFailure(
      new RepoRootResolver({
        platformPath: win32Path,
        executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
      }).resolveCanonicalRoot(String.raw`\repos\foo`),
      "not_absolute",
    );
    expect(recorded).toHaveLength(0);
  });

  it("carries a path-free message for a refused win32 root", async () => {
    const failure = await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\private-clients\acme-payments`,
      ),
      "not_absolute",
    );
    expect(failure.message).not.toContain("acme-payments");
    expect(failure.message).not.toMatch(/[/\\]/);
    expect(JSON.stringify(failure.detail)).not.toContain("acme-payments");
  });

  itOnPosix("keeps the root-length rule win32-only — a POSIX `/` root stays complete", async () => {
    // Scoping control: POSIX `/` parses to a root of length 1, like the refused win32 `\`. Had the
    // length test applied on both platforms, it would refuse every absolute POSIX path.
    //
    // POSIX-only because it feeds real fixture paths to `path.posix`, which rejects Windows
    // `C:\...` paths and would report a host mismatch as a scoping failure.
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

  it("throws path_not_found when a path component is not a directory", async () => {
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(join(fixtures.regularFile, "child")),
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

  it("maps an unrecognized filesystem errno to not_readable, never to a root", async () => {
    const resolver = new RepoRootResolver({
      realpath: () => Promise.reject(Object.assign(new Error("i/o error"), { code: "EIO" })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "not_readable",
    );
  });

  itOnPosixAsNonRoot("throws not_readable when the git-reported ROOT does not list", async () => {
    // Discriminates which value `finish` probes: the supplied path is a readable nested directory,
    // so only the reported toplevel refuses. A probe reading its input would pass this premise and
    // still admit the broken mount.
    //
    // The control comes first because the case means something only if discovery succeeds: git
    // never lists the toplevel, so the mode does not stop it. Otherwise the refusal would arrive
    // as `vcs_error`.
    const discovered = await runGitOrThrow(
      ["-C", fixtures.unreadableRepositoryNestedDirectory, "rev-parse", "--show-toplevel"],
      fixtures.environment,
    );
    expect(discovered.stdout.trim()).toBe(fixtures.unreadableRepositoryRoot);

    // The supplied path opens fine, so a probe reading its input would find nothing to refuse.
    // Asserted because it is this case's whole discriminating power.
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
    // The root vanished between discovery and the gate. It reads as a missing path, not a VCS
    // failure, even though a git query succeeded: a filesystem errno is never evidence about that
    // query (see `classifyRealpathFailure`).
    const resolver = new RepoRootResolver({
      probeDirectoryReadable: () =>
        Promise.reject(Object.assign(new Error("no such file or directory"), { code: "ENOENT" })),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "path_not_found",
    );
  });

  it("leaks no path into the thrown carrier", async () => {
    // The carrier must not echo the attempted path; this confirms the resolver adds no such
    // channel.
    const secretPath = join(fixtures.fixtureRoot, "private-clients", "acme-payments");
    const failure = await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(secretPath),
      "path_not_found",
    );
    expect(failure.message).not.toContain(secretPath);
    expect(failure.message).not.toMatch(/[/\\]/);
    expect(JSON.stringify(failure.detail)).not.toContain("acme-payments");
    // Negative control: the same assertions flag an echoing message, so the clean result above is
    // not vacuous.
    expect(`resolution failed: ${secretPath}`).toMatch(/[/\\]/);
  });
});

// ----------------------------------------------------------------------------
// Missing git — the headline case, on every platform
// ----------------------------------------------------------------------------

describe("a git that cannot run is vcs_error, never not_a_git_repository", () => {
  it("surfaces vcs_error when the git executable does not exist", async () => {
    // Real `execFile` against a nonexistent path, so the ENOENT is Node's own, not a hand-built
    // imitation. A host without git must not report a real repository as not being one.
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.missingGitExecutable,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "vcs_error",
    );
  });

  it("surfaces vcs_error for a REPOSITORY when git is missing, not a non-repository", async () => {
    // The same input the happy path resolves; `not_a_git_repository` here would report a real
    // repository as not being one.
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.missingGitExecutable,
    });
    const failure = await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "vcs_error",
    );
    expect(failure.reason).not.toBe("path_not_found");
  });

  it("surfaces vcs_error when the git path is a directory", async () => {
    const resolver = new RepoRootResolver({ gitExecutablePath: fixtures.fixtureRoot });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("surfaces vcs_error on a spawn errno rather than an exit code", async () => {
    // `execFile` puts an errno string in the same `code` slot an exit code occupies; the
    // classifier must not confuse the two.
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({ code: "ENOENT", stderr: "", stdout: "" }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("surfaces vcs_error when the executor rejects with a non-Error value", async () => {
    const resolver = new RepoRootResolver({ executeFile: rejectingExecutor(undefined) });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });
});

onPosix("a git that cannot run — POSIX process fixtures", () => {
  it("surfaces vcs_error when the git file is not executable", async () => {
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.nonExecutableGitFile,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "vcs_error",
    );
  });

  it("surfaces vcs_error when git dies on a signal", async () => {
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.signalKilledGitScript,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "vcs_error",
    );
  });

  it("surfaces vcs_error when git exits non-zero for an unrelated reason", async () => {
    const resolver = new RepoRootResolver({ gitExecutablePath: fixtures.failingGitScript });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.repositoryRoot),
      "vcs_error",
    );
  });

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

// ----------------------------------------------------------------------------
// Fail-closed classification — only a positive verdict is not_a_git_repository
// ----------------------------------------------------------------------------

describe("fail-closed not-a-repository classification", () => {
  it("reports not_a_git_repository on git's real exit-128 + not-a-repository stderr", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stdout: "",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });

  it("refuses the verdict when the marker sits inside a quoted path, not at line start", async () => {
    // A directory can be named "not a git repository"; without the line anchor its own error
    // message would be read as git's verdict.
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stderr: "fatal: cannot change to '/srv/not a git repository/inner': Not a directory\n",
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

  it("refuses a bare repository as vcs_error, not as a non-repository", async () => {
    // Real git: exit 128, "this operation must be run in a work tree". A bare repository has no
    // work tree to mount, which is not the absence of a repository.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.bareRepository),
      "vcs_error",
    );
  });

  it("refuses a regular file rather than persisting it as a canonical root", async () => {
    // Real git cannot chdir into a file; its stderr says "Not a directory", which carries no
    // marker, so the fail-closed default applies.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.regularFile),
      "vcs_error",
    );
  });
});

// ----------------------------------------------------------------------------
// Verdict consistency — a marker-matching verdict contradicted by visible
// `.git` metadata is vcs_error
// ----------------------------------------------------------------------------

/**
 * A checkout with damaged metadata produces the same exit code and anchored stderr as an honest
 * non-repository, so `classifyGitFailure`'s verdict needs a second observation.
 *
 * The absence controls keep this gate from turning every not-a-repository verdict into
 * `vcs_error`; a directory with no `.git` must still be refused as `not_a_git_repository`. There
 * are three: the exit-128 classification test above together with the real-git `plainDirectory`
 * refusal (no `.git` at all); the dangling-symlink case below (the name exists and resolves to
 * nothing, which a synthetic errno cannot prove); and the seam twin after it, which runs that
 * reading on every platform and uid.
 */
describe("damaged repository metadata is vcs_error, never not_a_git_repository", () => {
  it("refuses a directory whose `.git` is an EMPTY directory", async () => {
    // Empty `.git` directory. Nothing is unreadable: the probe opens the metadata directory, so
    // the reason is `vcs_error`, not `not_readable`. No mode bits, so it runs on every platform
    // and uid.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.damagedMetadataEmpty),
      "vcs_error",
    );
  });

  it("refuses a `.git` gitfile whose `gitdir:` target does not exist", async () => {
    // Dangling gitfile. The premise is verified inline: the shape must reach the not-a-repository
    // arm (marker-matching stderr) for the gate to be what refuses it. If a future git changed the
    // wording, the resolver would refuse for another reason and the test would pass while testing
    // nothing.
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
    // Permission-damaged `.git`. Gated on non-root POSIX because root opens a mode-`000`
    // directory: the probe and git's own read would both succeed, and the premise would not exist.
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
    // A real dangling symlink, which the synthetic ENOENT twin below cannot prove: reaching ENOENT
    // needs the probe to follow the link, and one that examined the link itself would call the
    // metadata present.
    //
    // The premise is asserted first: git reads this as absence too, in the generic wording an
    // honest non-repository gets. The dangling gitfile above is the contrast, where git names its
    // unreachable target. If a future git changed this wording, the resolver would refuse for
    // another reason, and this assertion catches it.
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
    // The seam half of the gate, synthetic so it runs on every platform and uid. A probe that
    // rejects ENOENT for the metadata path and resolves for the root is what a genuine
    // non-repository presents, and it must still be refused as `not_a_git_repository`.
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
    // The inverted reading: for `finish` a resolving probe is a pass, here it means damaged
    // metadata. A stub written for one misleads the other, which is why `probeDirectoryReadable`
    // documents both.
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

// ----------------------------------------------------------------------------
// Malformed success — a zero exit is not automatically a usable root
// ----------------------------------------------------------------------------

describe("malformed git success", () => {
  it("refuses an empty toplevel", async () => {
    const resolver = new RepoRootResolver({ executeFile: succeedingExecutor("\n") });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "vcs_error",
    );
  });

  it("refuses a relative toplevel", async () => {
    const resolver = new RepoRootResolver({ executeFile: succeedingExecutor("relative/root\n") });
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

  it("strips only the line terminator, preserving a trailing space in a directory name", async () => {
    // `.trim()` would invent a path that does not exist, a plausible but unresolvable root. The
    // input is the root itself with an identity `realpath` (no such directory exists), so trimming
    // would fail the assertion below and the containment check, from opposite directions.
    const rootEndingInSpace = `${join(fixtures.fixtureRoot, "trailing-space-root")} `;
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${rootEndingInSpace}\n`),
      realpath: (path: string) => Promise.resolve(path),
      probeDirectoryReadable: alwaysReadableProbe,
    });
    const resolution = await resolver.resolveCanonicalRoot(rootEndingInSpace);
    expect(resolution.canonicalRoot).toBe(rootEndingInSpace);
  });
});

// ----------------------------------------------------------------------------
// Line terminator — LF always, the CR only where a name cannot hold one
// ----------------------------------------------------------------------------

/**
 * A `platformPath` double with win32's separator over POSIX path shapes, for the `\r` strip,
 * whose only observable is a path the host filesystem must resolve. `path.win32` cannot produce
 * that, since every check on an outgoing value reads the real `node:path`.
 *
 * Not for gate-refusal cases: its `parse` matches no real platform, so those use `path.win32`
 * itself.
 */
const win32SeparatorOverPosixPaths: PlatformPathModule = {
  sep: win32Path.sep,
  isAbsolute: posixPath.isAbsolute,
  parse: () => ({ root: `C:${win32Path.sep}` }),
};

describe("the default realpath implementation is pinned", () => {
  it("is `node:fs/promises.realpath`, never the JS-walk implementation", () => {
    // Structural on purpose. The casing behavior this protects shows only on a case-insensitive
    // filesystem, which CI's ubuntu-only daemon leg is not, so the probe-gated tests cannot catch
    // a quiet swap there; this assertion fails on every platform.
    //
    // The hazard: Node documents `node:fs`'s callback `realpath` as doing no case conversion on
    // case-insensitive file systems. Defaulting to it would leave every other test green on CI
    // while a mis-cased attach broke on macOS.
    expect(DEFAULT_REALPATH).toBe(realpath);
  });
});

describe("line terminator stripping is platform-scoped", () => {
  it("strips a CRLF terminator on win32, where no name can end in a CR", async () => {
    // NTFS forbids control characters in names, so on win32 a `\r` before the final `\n` is
    // terminator noise from a shim or console layer.
    const resolver = new RepoRootResolver({
      platformPath: win32SeparatorOverPosixPaths,
      executeFile: succeedingExecutor(`${fixtures.repositoryRoot}\r\n`),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });

  it("preserves a trailing space on win32, where only the CR is terminator noise", async () => {
    // A name ending in a space must survive the win32 branch that drops a `\r`; `.trim()` would
    // satisfy every other test in this block and fail only this one.
    const rootEndingInSpace = `${join(fixtures.fixtureRoot, "trailing-space-root")} `;
    const resolver = new RepoRootResolver({
      platformPath: win32SeparatorOverPosixPaths,
      executeFile: succeedingExecutor(`${rootEndingInSpace}\r\n`),
      realpath: (path: string) => Promise.resolve(path),
      probeDirectoryReadable: alwaysReadableProbe,
    });
    const resolution = await resolver.resolveCanonicalRoot(rootEndingInSpace);
    expect(resolution.canonicalRoot).toBe(rootEndingInSpace);
  });

  itOnPosix("keeps a CR that is the last character of a POSIX directory name", async () => {
    // git ends plumbing output with a bare LF on every platform, so on POSIX, where `\r` is legal
    // in a name, a `\r` before that LF belongs to the name. The sibling spelled without `\r`
    // exists, so stripping it would resolve and persist a real but different directory as the
    // mount root.
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${fixtures.carriageReturnDirectory}\n`),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.carriageReturnDirectory);
    expect(resolution).toEqual({
      canonicalRoot: fixtures.carriageReturnDirectory,
      vcsType: "git",
    });
    expect(resolution.canonicalRoot).not.toBe(fixtures.carriageReturnSiblingDirectory);
    // Negative control: the sibling is resolvable, so the assertion above is about the strip and
    // not about an unresolvable path.
    expect(
      await new RepoRootResolver({
        executeFile: succeedingExecutor(`${fixtures.carriageReturnSiblingDirectory}\n`),
      }).resolveCanonicalRoot(fixtures.carriageReturnSiblingDirectory),
    ).toEqual({ canonicalRoot: fixtures.carriageReturnSiblingDirectory, vcsType: "git" });
  });

  itOnPosix("still strips the bare LF terminator on POSIX", async () => {
    // Only the `\r` is platform-conditional; a toplevel whose LF survived would name a directory
    // that does not exist.
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${fixtures.repositoryRoot}\n`),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });
});

// ----------------------------------------------------------------------------
// Redirected toplevel — a repository's OWN config, against real git
// ----------------------------------------------------------------------------

describe("a redirected toplevel is refused, never persisted", () => {
  itOnPosix("negative control — raw git IS redirected by a repo's own core.worktree", async () => {
    // Proves the hazard reproduces on this host's git; otherwise the two refusals below could pass
    // because git stopped honoring `core.worktree`.
    //
    // POSIX-only because it reads raw git stdout, which on Windows uses forward slashes that no
    // fixture path is spelled with. The refusals assert on resolver output and run everywhere.
    const redirected = await runGitOrThrow(
      ["-C", fixtures.siblingRedirectRoot, "rev-parse", "--show-toplevel"],
      fixtures.environment,
    );
    expect(redirected.stdout.trim()).toBe(fixtures.repositoryRoot);
    expect(redirected.stdout.trim()).not.toBe(fixtures.siblingRedirectRoot);
  });

  itOnPosix("mirror control — command-scope core.worktree does NOT redirect", async () => {
    // The other half of the asymmetry: neither `git -c` nor `GIT_CONFIG_COUNT` pairs move the
    // toplevel on this version, although git's config documentation ranks both above config files.
    // So the resolver's environment strip is defense in depth, and the two verification checks are
    // what close the vector.
    //
    // POSIX-only for the reason above: it reads raw git stdout.
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
      const injected = await runGitOrThrow(
        [...injection.leadingArgs, "-C", fixtures.repositoryRoot, "rev-parse", "--show-toplevel"],
        injection.environment,
      );
      expect(injected.stdout.trim(), injection.label).toBe(fixtures.repositoryRoot);
    }
  });

  it("refuses a sibling redirect with root_mismatch", async () => {
    // Attaching this would persist a `canonical_root` naming a tree the operator never supplied,
    // and binds under it would then be admitted. The redirect target is the fixture repository,
    // which self-reports honestly, so the self-report check would admit this shape; containment is
    // what refuses it.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.siblingRedirectRoot),
      "root_mismatch",
    );
  });

  it("refuses an ancestor redirect with root_mismatch", async () => {
    // The widening shape, and the reason containment alone is not enough: the supplied path sits
    // inside the reported root, so containment passes. Persisting it would put the mount's trust
    // envelope around a tree that merely contains what was attached (`core.worktree=/` is the
    // limit). The self-report check refuses it, because a parent directory does not report itself
    // as a toplevel.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.ancestorRedirectRoot),
      "root_mismatch",
    );
  });

  it("never resolves a redirected root", async () => {
    // The self-report check. In both shapes the verification query reports not-a-repository, the
    // same verdict that yields `not_a_git_repository` on the discovery query; here it must refuse
    // the claimed root.
    for (const redirectedInput of [fixtures.siblingRedirectRoot, fixtures.ancestorRedirectRoot]) {
      const settled = await new RepoRootResolver().resolveCanonicalRoot(redirectedInput).then(
        (value: RepoRootResolution) => ({ resolved: true as const, value }),
        (error: unknown) => ({ resolved: false as const, value: error }),
      );
      expect(settled.resolved, `${redirectedInput} must reject`).toBe(false);
    }
  });

  it("accepts a --separate-git-dir repository whose gitfile sits in its toplevel", async () => {
    // The boundary of the refusal: a separate git directory is not the hazard, a work tree pointed
    // away from the gitfile's directory is. `--separate-git-dir` sets no `core.worktree`, so this
    // self-reports and resolves.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.separateGitDirRoot,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.separateGitDirRoot, vcsType: "git" });
  });
});

// ----------------------------------------------------------------------------
// Verification legs — driven through the executor seam
// ----------------------------------------------------------------------------

describe("root verification is two independent legs", () => {
  it("refuses a root the supplied path does not sit inside — before spawning again", async () => {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.plainDirectory}\n`),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "root_mismatch",
    );
    // One invocation: containment runs first, so a root that does not contain the input never
    // becomes the `-C` argument of a second spawn.
    expect(recorded).toHaveLength(1);
  });

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

  it("refuses when the verification query reports not-a-repository", async () => {
    // The shape both real redirects produce: the claimed root is not a repository. The discovery
    // query reports the same verdict as `not_a_git_repository`; about the claimed root it is
    // `root_mismatch`.
    const resolver = new RepoRootResolver({
      executeFile: failingVerificationExecutor(
        `${fixtures.repositoryRoot}\n`,
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stdout: "",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "root_mismatch",
    );
  });

  it("keeps vcs_error when the verification query cannot complete", async () => {
    // A second spawn that fails abnormally verified nothing, so the reason stays `vcs_error`
    // rather than claiming a mismatch git never delivered. Both refuse; only the wire discriminant
    // differs.
    const resolver = new RepoRootResolver({
      executeFile: failingVerificationExecutor(
        `${fixtures.repositoryRoot}\n`,
        syntheticGitFailure({ code: "ENOENT", stdout: "", stderr: "" }),
      ),
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "vcs_error",
    );
  });

  it("admits a root that reports itself, and returns exactly it", async () => {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(recorded.map((invocation) => invocation.args)).toEqual([
      ["-C", fixtures.nestedDirectory, "rev-parse", "--show-toplevel"],
      ["-C", fixtures.repositoryRoot, "rev-parse", "--show-toplevel"],
    ]);
  });

  it("refuses a plain directory after one spawn — no second query", async () => {
    // The not-a-repository arm refuses on the discovery answer alone; there is no root to confirm.
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: (file: string, args: readonly string[], options: GitCommandOptions) => {
        recorded.push({ file, args, options });
        return Promise.reject(
          syntheticGitFailure({
            code: GIT_FATAL_EXIT_CODE,
            stdout: "",
            stderr: REAL_NOT_A_REPOSITORY_STDERR,
          }),
        );
      },
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
    expect(recorded).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Ambient GIT_* hijacking — in production environments
// ----------------------------------------------------------------------------

describe("ambient GIT_* variables cannot redirect discovery", () => {
  it("negative control — raw git IS hijacked by GIT_DIR", async () => {
    // Proves the hazard is real: with GIT_DIR exported, git answers about the ambient repository
    // and reports the plain directory as a toplevel. If this stops reproducing, the strip-list
    // tests below become vacuous.
    const hijacked = await runGitDirectly(
      ["-C", fixtures.plainDirectory, "rev-parse", "--show-toplevel"],
      { ...fixtures.environment, GIT_DIR: join(fixtures.repositoryRoot, ".git") },
    );
    expect(hijacked.exitCode).toBe(0);
    expect(hijacked.stdout.trim()).toBe(fixtures.plainDirectory);
  });

  it("still refuses a plain directory as not_a_git_repository with GIT_DIR exported", async () => {
    vi.stubEnv("GIT_DIR", join(fixtures.repositoryRoot, ".git"));
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory),
      "not_a_git_repository",
    );
  });

  it("still resolves a repository's own toplevel with GIT_WORK_TREE exported", async () => {
    vi.stubEnv("GIT_WORK_TREE", fixtures.plainDirectory);
    vi.stubEnv("GIT_DIR", join(fixtures.repositoryRoot, ".git"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });

  it("negative control — raw git IS blinded by GIT_CEILING_DIRECTORIES", async () => {
    const blinded = await runGitDirectly(
      ["-C", fixtures.nestedDirectory, "rev-parse", "--show-toplevel"],
      { ...fixtures.environment, GIT_CEILING_DIRECTORIES: join(fixtures.repositoryRoot, "nested") },
    );
    expect(blinded.exitCode).toBe(GIT_FATAL_EXIT_CODE);
    expect(blinded.stderr).toContain("not a git repository");
  });

  it("still resolves a repository with GIT_CEILING_DIRECTORIES exported", async () => {
    // The mirror-image breach: an ambient ceiling makes git report not-a-repository for a real
    // repository, which would become a `not_a_git_repository` refusal. Stripping prevents it.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", join(fixtures.repositoryRoot, "nested"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });

  it("negative control — raw git IS blinded by GIT_OBJECT_DIRECTORY", async () => {
    // A second mirror-image hazard, by a different mechanism: the variable enters git's own
    // is-this-a-repository predicate, so a value naming nothing accessible makes every candidate
    // fail it (git 2.50.1). The wording is the anchored `fatal: not a git repository`, which
    // `classifyGitFailure` reads as a positive verdict.
    const blinded = await runGitDirectly(
      ["-C", fixtures.nestedDirectory, "rev-parse", "--show-toplevel"],
      {
        ...fixtures.environment,
        GIT_OBJECT_DIRECTORY: join(fixtures.fixtureRoot, "absent-object-directory"),
      },
    );
    expect(blinded.exitCode).toBe(GIT_FATAL_EXIT_CODE);
    expect(blinded.stderr).toContain("not a git repository");
  });

  it("still resolves a repository with GIT_OBJECT_DIRECTORY exported", async () => {
    // The breach the strip closes. A nested subdirectory routes the blinded verdict to the
    // not-a-repository arm (the consistency gate looks for `<supplied>/.git`, which a subdirectory
    // lacks), so without the strip a live repository is refused as `not_a_git_repository`.
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(fixtures.fixtureRoot, "absent-object-directory"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });

  it("still resolves a repository root with GIT_OBJECT_DIRECTORY exported", async () => {
    // The root-attach half of the same hazard: `<supplied>/.git` exists, so without the strip the
    // consistency gate turns the blinded verdict into `vcs_error`. With the nested case, the strip
    // is asserted on both arms of the gate.
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(fixtures.fixtureRoot, "absent-object-directory"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });
});

// ----------------------------------------------------------------------------
// Invocation shape — argv-only, locale-pinned, bounded
// ----------------------------------------------------------------------------

describe("git invocation shape", () => {
  /**
   * Both invocations of one successful resolution, in order: discovery on the input, then
   * verification on the reported root. Returning the pair lets the hardening assertions cover
   * both spawns.
   */
  async function captureInvocations(): Promise<readonly [RecordedInvocation, RecordedInvocation]> {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    await resolver.resolveCanonicalRoot(fixtures.repositoryRoot);
    const [discovery, verification] = recorded;
    if (discovery === undefined || verification === undefined) {
      throw new Error(`the resolver made ${recorded.length} git invocation(s), expected 2`);
    }
    return [discovery, verification];
  }

  it("invokes the configured executable with the ratified argv and no others", async () => {
    const [invocation] = await captureInvocations();
    expect(invocation.file).toBe(DEFAULT_GIT_EXECUTABLE);
    expect(invocation.args).toEqual([
      "-C",
      fixtures.repositoryRoot,
      "rev-parse",
      "--show-toplevel",
    ]);
  });

  it("passes no shell option — argv-only execution is structural", async () => {
    const [invocation] = await captureInvocations();
    expect(Object.keys(invocation.options).sort()).toEqual([
      "env",
      "maxBuffer",
      "timeout",
      "windowsHide",
    ]);
    // Compile-time check: adding a `shell` member to the options type flips this to `false` and
    // fails typecheck, so the runtime check above cannot be outgrown.
    const optionsCarryNoShell: "shell" extends keyof GitCommandOptions ? false : true = true;
    expect(optionsCarryNoShell).toBe(true);
  });

  it("applies the default timeout, buffer cap, and windowsHide", async () => {
    const [invocation] = await captureInvocations();
    expect(invocation.options.timeout).toBe(DEFAULT_GIT_COMMAND_TIMEOUT_MS);
    expect(invocation.options.maxBuffer).toBe(GIT_STDIO_MAX_BUFFER_BYTES);
    expect(invocation.options.windowsHide).toBe(true);
  });

  it("pins the locale and blocks terminal prompting", async () => {
    // The not-a-repository verdict is read off git's stderr and git translates its messages, so a
    // localized shell must not change how it is read.
    const [invocation] = await captureInvocations();
    expect(invocation.options.env["LC_ALL"]).toBe("C");
    expect(invocation.options.env["LANG"]).toBe("C");
    expect(invocation.options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("pins its roster to the resolver's exported strip list — set equality both ways", () => {
    // The loop in the next test covers only the local roster, so a key the resolver starts
    // stripping would go uncovered. Set equality against the resolver's exported list closes that
    // direction; the two spellings stay independent.
    expect([...EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS].sort()).toStrictEqual(
      [...DISCOVERY_REDIRECTING_GIT_ENV_KEYS].sort(),
    );
  });

  it("deletes every discovery-redirecting GIT_* variable from the child environment", async () => {
    for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
      vi.stubEnv(key, "/ambient/hijack");
    }
    const [invocation] = await captureInvocations();
    for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
      expect(invocation.options.env[key]).toBeUndefined();
      expect(key in invocation.options.env).toBe(false);
    }
  });

  it("strips a redirecting variable inherited under ANY casing", async () => {
    // A Windows environment block is case-insensitive, so `Git_Dir` works as `GIT_DIR` for the
    // child. A copy-then-delete strip would miss it: the copy keeps each inherited key's spelling,
    // and `delete environment["GIT_DIR"]` matches one spelling.
    //
    // The assertion covers the whole built environment, so a strip that missed some other casing
    // fails too.
    vi.stubEnv("Git_Dir", "/ambient/hijack");
    vi.stubEnv("git_work_tree", "/ambient/hijack");
    vi.stubEnv("Git_Config_Parameters", "'core.worktree=/ambient/hijack'");
    vi.stubEnv("gIt_CeIlInG_dIrEcToRiEs", "/ambient/hijack");
    vi.stubEnv("Repo_Root_Resolver_Probe", "inherited");

    const [invocation] = await captureInvocations();
    const strippedKeys = new Set(EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS);
    for (const key of Object.keys(invocation.options.env)) {
      expect(strippedKeys.has(key.toUpperCase()), `${key} survived the strip`).toBe(false);
    }
    // Negative control: a mixed-case key not on the list survives, so the loop passes on a strip
    // and not on an empty environment.
    expect(invocation.options.env["Repo_Root_Resolver_Probe"]).toBe("inherited");
  });

  it("hardens the verification query exactly like the discovery query", async () => {
    // The second spawn is where a redirected root is checked, so it must run under the same
    // stripped, locale-pinned, bounded shape.
    for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
      vi.stubEnv(key, "/ambient/hijack");
    }
    vi.stubEnv("Git_Dir", "/ambient/hijack");

    const [discovery, verification] = await captureInvocations();
    expect(verification.file).toBe(discovery.file);
    expect(verification.options.timeout).toBe(DEFAULT_GIT_COMMAND_TIMEOUT_MS);
    expect(verification.options.maxBuffer).toBe(GIT_STDIO_MAX_BUFFER_BYTES);
    expect(verification.options.windowsHide).toBe(true);
    expect(verification.options.env["LC_ALL"]).toBe("C");
    expect(verification.options.env["LANG"]).toBe("C");
    expect(verification.options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    const strippedKeys = new Set(EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS);
    for (const key of Object.keys(verification.options.env)) {
      expect(strippedKeys.has(key.toUpperCase()), `${key} survived the strip`).toBe(false);
    }
  });

  it("still inherits the rest of the environment, PATH included", async () => {
    // The strip must not amount to a scrubbed environment: a bare `git` is resolved through the
    // child's PATH.
    vi.stubEnv("REPO_ROOT_RESOLVER_PROBE", "inherited");
    const [invocation] = await captureInvocations();
    expect(invocation.options.env["REPO_ROOT_RESOLVER_PROBE"]).toBe("inherited");
    expect(invocation.options.env["PATH"]).toBe(process.env["PATH"]);
  });

  it("reads the environment at call time, not at construction", async () => {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    vi.stubEnv("REPO_ROOT_RESOLVER_PROBE", "set-after-construction");
    await resolver.resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(recorded[0]?.options.env["REPO_ROOT_RESOLVER_PROBE"]).toBe("set-after-construction");
  });
});

describe("no unresolved or guessed root ever escapes", () => {
  it("rejects — never resolves — for every failing input shape", async () => {
    const failingCases: ReadonlyArray<{
      readonly label: string;
      readonly resolver: RepoRootResolver;
      readonly input: string;
    }> = [
      {
        label: "non-absolute path",
        resolver: new RepoRootResolver(),
        input: "src/workspace",
      },
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
      {
        label: "regular file",
        resolver: new RepoRootResolver(),
        input: fixtures.regularFile,
      },
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

  it("never returns the raw user-entered path when it differs from the canonical root", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.symlinkToNestedDirectory,
    );
    expect(resolution.canonicalRoot).not.toBe(fixtures.symlinkToNestedDirectory);
    expect(resolution.canonicalRoot).toBe(fixtures.repositoryRoot);
  });
});

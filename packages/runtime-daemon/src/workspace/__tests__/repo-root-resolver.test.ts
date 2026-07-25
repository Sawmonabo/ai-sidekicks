// repo-root-resolver.test.ts — resolution, classification, and fail-closed
// pins for the canonical repo-root resolver (Plan-009 Phase 1 T1.5).
//
// Spec coverage:
//   * `Spec-009 §Required Behavior` — "Repo attach must resolve and persist the
//     canonical repository root, not only the user-entered path."
//     → §canonical resolution, §symlink canonicalization.
//   * `Spec-009 §Implementation Notes` — "Repo attach should not assume that
//     the user-selected path is already the repo root."
//     → §canonical resolution (nested subdirectory, linked worktree, submodule).
//   * `Spec-009 §Fallback Behavior` — "If a path is not a git repository, the
//     system may bind it as a plain directory workspace."
//     → §plain-directory classification.
//   * `Spec-009 §Fallback Behavior` — "If canonical root resolution fails,
//     repo attach must fail explicitly rather than guessing."
//     → §explicit failure, §fail-closed classification.
//
// Invariants covered (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-1 — canonical-root fidelity. Every returned root is absolute and
//     symlink-resolved, and is never the user-entered alias.
//     → §canonical resolution, §symlink canonicalization, §ambient GIT_*.
//   * I-009-2 — explicit resolution failure. Every non-resolution REJECTS with
//     a typed, path-free `RepoRootResolutionError`; no call returns a partial
//     or guessed root — including the root the daemon would produce by
//     completing an incomplete input from its own state: a relative path from
//     its working directory, `~` from its home, a driveless Windows root from
//     its current drive.
//     → §absoluteness gate, §win32 path shapes, §explicit failure,
//       §no partial success.
//   * I-009-4 — honest non-git classification. `vcsType: "none"` is produced
//     only on a positive not-a-repository verdict from git itself; a missing,
//     non-executable, killed, or otherwise broken git is `vcs_error`.
//     → §missing git, §fail-closed classification, §ambient GIT_*.
//
// Fixture strategy. Real git against real temp directories for everything real
// git can produce (nested subdirectory, symlink, plain directory, the two
// `.git`-is-a-FILE shapes — a linked worktree and a submodule — bare
// repository, regular file); the injected
// executor seam only for shapes real git cannot be made to emit on demand
// (wording/exit-code drift, a corpse that still carries an exit code) and for
// argv/environment inspection. The missing-git case runs through the REAL
// `execFile` with `gitExecutablePath` pointed at a nonexistent file, so the
// headline I-009-4 test discriminates a genuine Node `ENOENT` rather than a
// hand-written imitation of one, and needs no platform gate.
//
// The third seam, `platformPath`, exists so PLATFORM shapes are testable the
// same way: injecting `path.win32` drives the resolver's Windows branch on a
// POSIX runner. Without it the driveless-root refusal — the one gate case that
// only Windows can produce — would be asserted nowhere in CI.
//
// Fixture git runs under its own hermetic environment (`GIT_CONFIG_NOSYSTEM`,
// `HOME`/`XDG_CONFIG_HOME`/`GIT_CONFIG_GLOBAL` inside the temp root, explicit
// author/committer identity) so a developer's global git config cannot change
// what these tests observe. That environment is NOT the resolver's, and the
// difference is deliberate rather than incidental: a TEST fixture wants
// hermeticity, so it redirects config away from the developer's; the RESOLVER
// is production behavior, so it honors an operator's own redirection on the
// same trust plane as `PATH` and strips only key INJECTION
// (`GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`, the two independent
// channels). The resolver's environment is asserted separately below.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  posix as posixPath,
  resolve as resolvePath,
  win32 as win32Path,
} from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RepoRootResolutionError, type RepoRootResolutionReason } from "../repo-errors.js";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
  GIT_FATAL_EXIT_CODE,
  GIT_STDIO_MAX_BUFFER_BYTES,
  RepoRootResolver,
  type GitCommandFailure,
  type RepoRootResolution,
  type GitCommandOptions,
  type GitCommandResult,
  type GitFileExecutor,
} from "../repo-root-resolver.js";

// Three classes of case need a POSIX host. Shell-script fixtures (a git that
// dies on a signal, a git that hangs) have no portable Windows form; and two of
// the §win32 cases below are written against a host whose real filesystem is
// NOT Windows — each says why at its own site. Everything else in this file
// runs everywhere, including all I-009-4 classification pins. Note that Windows
// PATH HANDLING is not in the POSIX-only set: it is covered from POSIX by
// injecting `path.win32` into the gate rather than waiting on a Windows runner.
//
// CI is ubuntu-only today, so the skips are latent; `.github/workflows/ci.yml`
// names the widening intent, and a green Windows leg on day one is worth more
// than two cases that were only ever true by accident of the runner.
const onPosix = describe.skipIf(process.platform === "win32");
const itOnPosix = it.skipIf(process.platform === "win32");

// ----------------------------------------------------------------------------
// Real-git fixtures
// ----------------------------------------------------------------------------

/**
 * Everything the resolver strips, spelled out INDEPENDENTLY of the resolver's
 * own list rather than re-exported from it — the census below pins the two
 * together, and a mirror that imported its expectation would have nothing to
 * pin. Five direct discovery redirectors plus the two INDEPENDENT env-borne
 * config-injection channels: `GIT_CONFIG_COUNT`, the switch that makes
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs live, and
 * `GIT_CONFIG_PARAMETERS`, which is not gated on that count. Both are stripped
 * as defense in depth rather than on a demonstrated redirection — the
 * resolver's own list documents the empirical severity.
 */
const EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];

/**
 * The environment FIXTURE git runs under. Hermetic by construction: no system
 * config, no global config, a `HOME` inside the temp root, and an explicit
 * identity so the seed commit needs no `user.name` on the host. Distinct from
 * the environment the RESOLVER builds, which is deliberately production-shaped.
 */
function buildFixtureEnvironment(fixtureRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
    delete environment[key];
  }
  environment["HOME"] = fixtureRoot;
  environment["XDG_CONFIG_HOME"] = join(fixtureRoot, "xdg");
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  // A path that does not exist, INSIDE the temp root — platform-agnostic where
  // `/dev/null` is not.
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
          // A non-zero exit RESOLVES with its code rather than rejecting: the
          // negative controls below assert on git's failure output, and it is
          // `runGitOrThrow` that turns a failed fixture command into a throw.
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
  readonly nestedDirectory: string;
  readonly symlinkToNestedDirectory: string;
  readonly plainDirectory: string;
  readonly symlinkToPlainDirectory: string;
  readonly regularFile: string;
  readonly bareRepository: string;
  readonly linkedWorktreeRoot: string;
  readonly superprojectRoot: string;
  readonly submoduleRoot: string;
  readonly submoduleNestedDirectory: string;
  readonly missingGitExecutable: string;
  readonly nonExecutableGitFile: string;
  readonly failingGitScript: string;
  readonly signalKilledGitScript: string;
  readonly hangingGitScript: string;
  readonly environment: NodeJS.ProcessEnv;
}

let fixtures: Fixtures;

/**
 * Writes an executable `/bin/sh` stand-in for git. The timeout script uses
 * `exec` so the sleeping process IS the direct child: a forked grandchild would
 * survive the kill still holding the stdio pipes, and `execFile`'s callback
 * would not fire until they closed.
 */
async function writeExecutableScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

beforeAll(async () => {
  // Realpath the temp root ONCE, and derive every expected value from it: on
  // macOS `os.tmpdir()` is `/var/folders/...`, itself a symlink to
  // `/private/var/folders/...`. That aliasing is precisely what the resolver
  // canonicalizes, so an expectation built from the un-resolved mkdtemp output
  // would mismatch on every assertion.
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
  const symlinkToPlainDirectory = join(fixtureRoot, "link-to-plain");
  await symlink(nestedDirectory, symlinkToNestedDirectory);
  await symlink(plainDirectory, symlinkToPlainDirectory);

  const bareRepository = join(fixtureRoot, "bare.git");
  const linkedWorktreeRoot = join(fixtureRoot, "linked-worktree");
  await runGitOrThrow(["init", "-q", repositoryRoot], environment);
  await runGitOrThrow(["init", "-q", "--bare", bareRepository], environment);
  // A linked worktree needs a commit to branch from. It is the fixture that
  // proves the mechanism choice: inside it, `.git` is a FILE, so the parent-walk
  // alternative Plan-009 T1.5 rejects would find no repository here.
  await runGitOrThrow(
    ["-C", repositoryRoot, "commit", "-q", "--allow-empty", "-m", "seed"],
    environment,
  );
  await runGitOrThrow(
    ["-C", repositoryRoot, "worktree", "add", "-q", "-b", "fixture-wt", linkedWorktreeRoot],
    environment,
  );

  // Submodule fixture — the SECOND `.git`-is-a-FILE shape, and the one whose
  // answer Phase 2 persists for a nested checkout. `protocol.file.allow=always`
  // is required from git 2.38.1 onward (CVE-2022-39253 hardening): without it a
  // local-path `submodule add` dies with "transport 'file' not allowed" (exit
  // 128, observed on git 2.50.1). Scoped to this one invocation via `-c`, over a
  // source repository this suite created inside its own temp root, so it relaxes
  // nothing outside the fixture. Older git ignores the unknown key, so the flag
  // is safe in both directions.
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
  // The source repository carries only an empty seed commit, so the checkout is
  // empty; the nested directory is what makes the input a path BELOW the
  // submodule root rather than the root itself.
  await mkdir(submoduleNestedDirectory, { recursive: true });

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
    nestedDirectory,
    symlinkToNestedDirectory,
    plainDirectory,
    symlinkToPlainDirectory,
    regularFile,
    bareRepository,
    linkedWorktreeRoot,
    superprojectRoot,
    submoduleRoot,
    submoduleNestedDirectory,
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
 * A rejection shaped like `execFile`'s. The wording below is what real git
 * emits — pinned from observed output, not copied from the resolver's matcher,
 * so a test that passes is evidence about git rather than about itself.
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

/** Captures the invocation, then answers with a real, resolvable toplevel. */
function recordingExecutor(recorded: RecordedInvocation[], stdout: string): GitFileExecutor {
  return (file: string, args: readonly string[], options: GitCommandOptions) => {
    recorded.push({ file, args, options });
    return Promise.resolve<GitCommandResult>({ stdout, stderr: "" });
  };
}

/**
 * Asserts the rejection is the typed carrier with the expected reason. The
 * `reason` parameter takes the union itself rather than a hand-listed subset,
 * so a member added to `RepoRootResolutionReason` is usable here with no edit.
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

// ----------------------------------------------------------------------------
// Canonical resolution — Spec-009 §Required Behavior + §Implementation Notes
// ----------------------------------------------------------------------------

describe("canonical resolution against real git (I-009-1)", () => {
  it("resolves a nested subdirectory to the repository toplevel", async () => {
    // The case `Spec-009 §Implementation Notes` names: the user-selected path
    // is not the repo root, and the resolver must walk to the real toplevel.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toBe(fixtures.nestedDirectory);
  });

  it("resolves the repository root itself to the same value", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.repositoryRoot);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });

  it("resolves a linked worktree to the worktree root, where .git is a FILE", async () => {
    // The mechanism pin. A parent-walk looking for a `.git` DIRECTORY finds
    // none here (`.git` is a file holding a `gitdir:` pointer), which is why
    // Plan-009 T1.5 ratifies `rev-parse` instead.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.linkedWorktreeRoot,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.linkedWorktreeRoot, vcsType: "git" });
  });

  it("resolves a path inside a submodule to the SUBMODULE root, not the superproject", async () => {
    // The second `.git`-is-a-FILE shape, and the one Phase 2 persistence turns
    // on: a submodule is its own repository, so a checkout nested inside one
    // canonicalizes to the submodule root. Answering with the superproject
    // would put the mount's trust envelope (I-009-3) around a wider tree than
    // the operator attached, and would collide on the D-009-7 uniqueness index
    // with a separate attach of the superproject itself.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.submoduleNestedDirectory,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.submoduleRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toBe(fixtures.superprojectRoot);
  });

  it("classifies a plain directory as none with its realpath as the root", async () => {
    // `Spec-009 §Fallback Behavior` — the plain-directory classification, and
    // the ONLY route to `vcsType: "none"`.
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.plainDirectory, vcsType: "none" });
  });

  it("returns an absolute root for every accepted input shape", async () => {
    const resolver = new RepoRootResolver();
    for (const input of [
      fixtures.nestedDirectory,
      fixtures.repositoryRoot,
      fixtures.symlinkToNestedDirectory,
      fixtures.plainDirectory,
      fixtures.symlinkToPlainDirectory,
      fixtures.linkedWorktreeRoot,
      fixtures.submoduleNestedDirectory,
    ]) {
      const resolution = await resolver.resolveCanonicalRoot(input);
      expect(isAbsolute(resolution.canonicalRoot)).toBe(true);
    }
  });
});

// ----------------------------------------------------------------------------
// Symlink canonicalization — Spec-009 §Required Behavior (I-009-1)
// ----------------------------------------------------------------------------

describe("symlink canonicalization (I-009-1)", () => {
  it("resolves a symlink to a repo subdirectory to the symlink-resolved toplevel", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.symlinkToNestedDirectory,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
    expect(resolution.canonicalRoot).not.toContain("link-to-nested");
  });

  it("resolves a symlink to a plain directory to the symlink-resolved directory", async () => {
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(
      fixtures.symlinkToPlainDirectory,
    );
    expect(resolution).toEqual({ canonicalRoot: fixtures.plainDirectory, vcsType: "none" });
    expect(resolution.canonicalRoot).not.toContain("link-to-plain");
  });

  it("hands git the realpath'd input, never the alias the caller supplied", async () => {
    // Order is load-bearing: canonicalizing BEFORE the query is what makes the
    // symlink guarantee structural rather than a side effect of git's own
    // getcwd() behavior.
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    await resolver.resolveCanonicalRoot(fixtures.symlinkToNestedDirectory);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.args).toEqual([
      "-C",
      fixtures.nestedDirectory,
      "rev-parse",
      "--show-toplevel",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Absoluteness gate — the daemon never completes a path from its own state
// ----------------------------------------------------------------------------

describe("non-absolute input is refused before resolution (I-009-2)", () => {
  // `realpath` resolves a relative path against the DAEMON process's working
  // directory. That is a base directory the daemon supplied from its own state,
  // and under the cross-node model it is not the author's context — so the root
  // it produces is a guess, and a plausible-looking one. These cases pin the
  // refusal, and pin that it happens BEFORE any resolution work.

  it("refuses a bare relative path with not_absolute, not a filesystem reason", async () => {
    // The specificity is the point. `path_not_found` or `vcs_error` here would
    // mean the gate did not fire and the input merely failed later, by luck.
    const failure = await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot("src/workspace"),
      "not_absolute",
    );
    expect(failure.reason).not.toBe("path_not_found");
    expect(failure.reason).not.toBe("vcs_error");
    expect(failure.reason).not.toBe("not_readable");
  });

  it("never returns the daemon-cwd-resolved root for a relative input", async () => {
    // The exact silent-wrong-answer shape this gate exists to stop. Under
    // vitest the daemon's cwd sits inside the ai-sidekicks checkout, so
    // `src/workspace` names a real and resolvable directory relative to it —
    // without the gate, resolution succeeds and answers about the wrong tree.
    const cwdRelativeInput = "src/workspace";
    const settled = await new RepoRootResolver().resolveCanonicalRoot(cwdRelativeInput).then(
      (value: RepoRootResolution) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, value: error }),
    );
    expect(settled.resolved).toBe(false);
    // Negative control — the daemon's cwd DOES contain a resolvable root for
    // this input, so the refusal above is a real refusal and not an artifact of
    // the input being unresolvable anywhere.
    const daemonCwdRoot = await new RepoRootResolver().resolveCanonicalRoot(
      resolvePath(process.cwd(), cwdRelativeInput),
    );
    expect(isAbsolute(daemonCwdRoot.canonicalRoot)).toBe(true);
    expect(settled.value).toBeInstanceOf(RepoRootResolutionError);
    expect(JSON.stringify(settled.value)).not.toContain(daemonCwdRoot.canonicalRoot);
  });

  it("refuses a `~`-prefixed path with not_absolute — loudly, not by accident", async () => {
    // `~` is never expanded here, so absent the gate the filesystem is asked
    // for a literal directory of that name: the refusal would be contingent on
    // no such directory existing, and a machine that had one would RESOLVE,
    // silently substituting the daemon's filesystem for the author's.
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
    // The empty string names nothing at all, so the same rule refuses it —
    // rather than a filesystem probe reporting it merely missing, which would
    // describe the wrong defect.
    await expectResolutionFailure(new RepoRootResolver().resolveCanonicalRoot(""), "not_absolute");
  });

  it("never spawns git for a non-absolute input", async () => {
    // Structural proof the gate precedes resolution: no executor call at all.
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
      fixtures.plainDirectory,
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

describe("win32 driveless roots are refused, complete roots admitted (I-009-2)", () => {
  // `path.win32.isAbsolute` short-circuits on a leading separator before it
  // ever looks for a drive, so `\repos\foo` reports absolute while naming no
  // volume. Resolving it takes the volume from the daemon process's CURRENT
  // DRIVE — the same guessed-root defect as a relative path taking the cwd,
  // and reachable with ordinary Windows CLI input. ADR-019 makes Windows a V1
  // tier, so "covered only on a Windows runner" would mean uncovered.
  //
  // Every case here injects a platform `path` — `path.win32`, except the
  // closing scoping control, which injects `path.posix` to pin that the
  // root-length rule did not leak across. Note what these tests CANNOT assert:
  // a full successful resolution, because `finish` re-checks the outgoing root
  // with the real `node:path` (deliberately — it is the backstop for a broken
  // seam) and no win32 path is absolute to a POSIX `isAbsolute`. So an admitted
  // input is pinned by the reason it fails with LATER: `path_not_found` from
  // `realpath` means step 1 passed it through.

  it("refuses a backslash-rooted path that names no drive", async () => {
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot(
        String.raw`\repos\foo`,
      ),
      "not_absolute",
    );
  });

  it("refuses the forward-slash spelling of the same driveless root", async () => {
    // Windows accepts `/` as a separator, so this is the identical shape and
    // must not slip through on spelling.
    await expectResolutionFailure(
      new RepoRootResolver({ platformPath: win32Path }).resolveCanonicalRoot("/repos/foo"),
      "not_absolute",
    );
  });

  it("refuses a drive-RELATIVE path", async () => {
    // `C:foo` means "foo, relative to the current directory ON drive C" —
    // incomplete in a second way. `isAbsolute` already reports false, so this
    // pins that the added root-length rule did not accidentally admit it.
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
    // A UNC root (`\\server\share\`) names a complete location without any
    // drive letter, which is why the rule reads the parsed root's length
    // rather than looking for a `:`.
    //
    // POSIX-only: the assertion is that step 1 PASSED this through, read off
    // the reason it fails with later. On a POSIX host `realpath` cannot find
    // `\\server\share\repo` and returns ENOENT, so `path_not_found` is a
    // reliable proxy. A Windows host would actually attempt the network name —
    // slow, and failing with an errno that maps to `not_readable` instead.
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
    // The scoping control. POSIX `/` parses to a root of length 1, exactly like
    // the win32 `\` refused above; if the length test were applied on both
    // platforms it would refuse every absolute POSIX path. Reaching
    // `path_not_found` proves it did not.
    //
    // POSIX-only because it injects `path.posix` and then feeds it real fixture
    // paths. On Windows those are `C:\...`, which `path.posix.isAbsolute`
    // rejects — both halves would throw `not_absolute` and the control would
    // report a scoping failure that is really just a host mismatch.
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

// ----------------------------------------------------------------------------
// Explicit failure — Spec-009 §Fallback Behavior (I-009-2)
// ----------------------------------------------------------------------------

describe("explicit failure on an unusable path (I-009-2)", () => {
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
    // Driven through the seam rather than `chmod 000`: a real permission
    // fixture is a no-op under root, which is how CI containers commonly run,
    // so the real-filesystem form would silently stop testing anything.
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

  it("leaks no path into the thrown carrier", async () => {
    // `error-contracts.md §Repo` bars this code from echoing the attempted
    // path; T1.4 removes the channel, and this confirms the resolver adds none.
    const secretPath = join(fixtures.fixtureRoot, "private-clients", "acme-payments");
    const failure = await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(secretPath),
      "path_not_found",
    );
    expect(failure.message).not.toContain(secretPath);
    expect(failure.message).not.toMatch(/[/\\]/);
    expect(JSON.stringify(failure.detail)).not.toContain("acme-payments");
    // Negative control — the same assertions DO flag an echoing message, so a
    // clean result above is not vacuous.
    expect(`resolution failed: ${secretPath}`).toMatch(/[/\\]/);
  });
});

// ----------------------------------------------------------------------------
// Missing git — the headline I-009-4 case, on every platform
// ----------------------------------------------------------------------------

describe("a git that cannot run is vcs_error, never none (I-009-4)", () => {
  it("surfaces vcs_error when the git executable does not exist", async () => {
    // REAL `execFile` against a path that is not there: the ENOENT this
    // discriminates is Node's own, not a hand-built imitation. A host without
    // git must not reclassify a real repository as a plain directory.
    const resolver = new RepoRootResolver({
      gitExecutablePath: fixtures.missingGitExecutable,
    });
    await expectResolutionFailure(
      resolver.resolveCanonicalRoot(fixtures.nestedDirectory),
      "vcs_error",
    );
  });

  it("surfaces vcs_error for a REPOSITORY when git is missing — no none fallback", async () => {
    // The same input the happy path classifies `git`. If the missing binary
    // produced `none` here, the capability projection would advertise a plain
    // directory for a real repository — the exact I-009-4 breach.
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
    // `execFile` puts an errno STRING in the same `code` slot an exit code
    // occupies. The classifier must never confuse the two.
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

onPosix("a git that cannot run — POSIX process fixtures (I-009-4)", () => {
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
// Fail-closed classification — only a positive verdict yields "none"
// ----------------------------------------------------------------------------

describe("fail-closed not-a-repository classification (I-009-4)", () => {
  it("classifies none on git's real exit-128 + not-a-repository stderr", async () => {
    const resolver = new RepoRootResolver({
      executeFile: rejectingExecutor(
        syntheticGitFailure({
          code: GIT_FATAL_EXIT_CODE,
          stdout: "",
          stderr: REAL_NOT_A_REPOSITORY_STDERR,
        }),
      ),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.plainDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.plainDirectory, vcsType: "none" });
  });

  it("refuses the verdict when the marker sits inside a quoted path, not at line start", async () => {
    // A directory can be NAMED "not a git repository". Without the line anchor
    // its own error message would classify it as a plain directory.
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

  it("refuses a bare repository rather than calling it a plain directory", async () => {
    // Real git: exit 128, "this operation must be run in a work tree". A bare
    // repository is neither a workspace root nor a plain directory.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.bareRepository),
      "vcs_error",
    );
  });

  it("refuses a regular file rather than persisting it as a canonical root", async () => {
    // Real git cannot chdir into a file; its stderr says "Not a directory",
    // which carries no marker, so the fail-closed default applies.
    await expectResolutionFailure(
      new RepoRootResolver().resolveCanonicalRoot(fixtures.regularFile),
      "vcs_error",
    );
  });
});

// ----------------------------------------------------------------------------
// Malformed success — a zero exit is not automatically a usable root
// ----------------------------------------------------------------------------

describe("malformed git success (I-009-1, I-009-2)", () => {
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
    // `.trim()` here would invent a path that does not exist — a plausible but
    // unresolvable root, the worst failure shape for a value Phase 2 persists.
    const rootEndingInSpace = `${join(fixtures.fixtureRoot, "trailing-space-root")} `;
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${rootEndingInSpace}\n`),
      realpath: (path: string) => Promise.resolve(path),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.plainDirectory);
    expect(resolution.canonicalRoot).toBe(rootEndingInSpace);
  });

  it("accepts a CRLF-terminated toplevel", async () => {
    const resolver = new RepoRootResolver({
      executeFile: succeedingExecutor(`${fixtures.repositoryRoot}\r\n`),
    });
    const resolution = await resolver.resolveCanonicalRoot(fixtures.plainDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });
});

// ----------------------------------------------------------------------------
// Ambient GIT_* hijacking — I-009-1 + I-009-4 in production environments
// ----------------------------------------------------------------------------

describe("ambient GIT_* variables cannot redirect discovery (I-009-1, I-009-4)", () => {
  it("negative control — raw git IS hijacked by GIT_DIR", async () => {
    // Proves the hazard is real: with GIT_DIR exported, git answers about the
    // ambient repository and reports the plain directory as a git toplevel. If
    // this control ever stops reproducing, the strip-list tests below become
    // vacuous and should be re-derived.
    const hijacked = await runGitDirectly(
      ["-C", fixtures.plainDirectory, "rev-parse", "--show-toplevel"],
      { ...fixtures.environment, GIT_DIR: join(fixtures.repositoryRoot, ".git") },
    );
    expect(hijacked.exitCode).toBe(0);
    expect(hijacked.stdout.trim()).toBe(fixtures.plainDirectory);
  });

  it("still classifies a plain directory as none with GIT_DIR exported", async () => {
    vi.stubEnv("GIT_DIR", join(fixtures.repositoryRoot, ".git"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.plainDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.plainDirectory, vcsType: "none" });
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
    // The mirror-image breach: an ambient ceiling makes git report
    // not-a-repository for a REAL repository, which the classifier would
    // faithfully turn into `vcsType: "none"`. Stripping is what prevents it.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", join(fixtures.repositoryRoot, "nested"));
    const resolution = await new RepoRootResolver().resolveCanonicalRoot(fixtures.nestedDirectory);
    expect(resolution).toEqual({ canonicalRoot: fixtures.repositoryRoot, vcsType: "git" });
  });
});

// ----------------------------------------------------------------------------
// Invocation shape — argv-only, locale-pinned, bounded
// ----------------------------------------------------------------------------

describe("git invocation shape", () => {
  async function captureInvocation(): Promise<RecordedInvocation> {
    const recorded: RecordedInvocation[] = [];
    const resolver = new RepoRootResolver({
      executeFile: recordingExecutor(recorded, `${fixtures.repositoryRoot}\n`),
    });
    await resolver.resolveCanonicalRoot(fixtures.repositoryRoot);
    const invocation = recorded[0];
    if (invocation === undefined) {
      throw new Error("the resolver made no git invocation");
    }
    return invocation;
  }

  it("invokes the configured executable with the ratified argv and no others", async () => {
    const invocation = await captureInvocation();
    expect(invocation.file).toBe(DEFAULT_GIT_EXECUTABLE);
    expect(invocation.args).toEqual([
      "-C",
      fixtures.repositoryRoot,
      "rev-parse",
      "--show-toplevel",
    ]);
  });

  it("passes no shell option — argv-only execution is structural", async () => {
    const invocation = await captureInvocation();
    expect(Object.keys(invocation.options).sort()).toEqual([
      "env",
      "maxBuffer",
      "timeout",
      "windowsHide",
    ]);
    // Compile-time leg: adding a `shell` member to the options type would flip
    // this to `false` and fail typecheck, so the runtime check above cannot be
    // quietly outgrown.
    const optionsCarryNoShell: "shell" extends keyof GitCommandOptions ? false : true = true;
    expect(optionsCarryNoShell).toBe(true);
  });

  it("applies the default timeout, buffer cap, and windowsHide", async () => {
    const invocation = await captureInvocation();
    expect(invocation.options.timeout).toBe(DEFAULT_GIT_COMMAND_TIMEOUT_MS);
    expect(invocation.options.maxBuffer).toBe(GIT_STDIO_MAX_BUFFER_BYTES);
    expect(invocation.options.windowsHide).toBe(true);
  });

  it("pins the locale and blocks terminal prompting", async () => {
    // The not-a-repository verdict is read off git's stderr, and git translates
    // its messages; an operator's localized shell must not change how a plain
    // directory is classified.
    const invocation = await captureInvocation();
    expect(invocation.options.env["LC_ALL"]).toBe("C");
    expect(invocation.options.env["LANG"]).toBe("C");
    expect(invocation.options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("pins its roster to the resolver's exported strip list — set equality both ways", () => {
    // The assertion below loops over the LOCAL roster, so it only ever proves
    // what this file already knows to name: a key the resolver starts
    // stripping would go silently uncovered. Set equality against the
    // resolver's exported list closes that direction, and the two spellings
    // stay independent so neither side can drift alone.
    expect([...EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS].sort()).toStrictEqual(
      [...DISCOVERY_REDIRECTING_GIT_ENV_KEYS].sort(),
    );
  });

  it("deletes every discovery-redirecting GIT_* variable from the child environment", async () => {
    for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
      vi.stubEnv(key, "/ambient/hijack");
    }
    const invocation = await captureInvocation();
    for (const key of EXPECTED_DISCOVERY_REDIRECTING_GIT_ENV_KEYS) {
      expect(invocation.options.env[key]).toBeUndefined();
      expect(key in invocation.options.env).toBe(false);
    }
  });

  it("still inherits the rest of the environment, PATH included", async () => {
    // Deleting the discovery variables must not amount to a scrubbed
    // environment: a bare `git` is resolved through the child's own PATH.
    vi.stubEnv("REPO_ROOT_RESOLVER_PROBE", "inherited");
    const invocation = await captureInvocation();
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

// ----------------------------------------------------------------------------
// No partial success — the structural form of I-009-2
// ----------------------------------------------------------------------------

describe("no unresolved or guessed root ever escapes (I-009-2)", () => {
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

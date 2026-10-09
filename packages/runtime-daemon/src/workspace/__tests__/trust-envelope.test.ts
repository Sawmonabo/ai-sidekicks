// Proves the trust-envelope validator never returns an execution root outside the attached mount a
// bind names: traversal, symlink escapes, prefix collisions, another mount, another repository,
// working trees git does not list now and drive-less win32 shapes are refused, an accepted root
// comes back symlink-resolved with its checkout, and win32 and case-insensitive filesystems compare
// paths case-folded. Real git answers which working tree a folder sits in.

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixtureEnvironment, runFixtureGit } from "../../git/__fixtures__/command.js";
import { TrustEnvelopeViolationError } from "../repo/errors.js";
import { RepoRootResolver, type WorkingTreeReader } from "../repo/root-resolver.js";
import {
  TrustEnvelopeValidator,
  type DirectoryReadabilityProbe,
  type PathRealpathResolver,
  type WorkspaceExecutionRootCandidate,
} from "../trust-envelope.js";

/** A readability probe that admits every directory, for resolvers over synthetic paths. */
const alwaysReadableProbe: DirectoryReadabilityProbe = () => Promise.resolve();

/**
 * Whether the filesystem under `os.tmpdir()` is case-insensitive, found by creating a directory in
 * one spelling and stat-ing the other. It is probed, not derived from `process.platform`, because
 * APFS can be case-sensitive and Linux can mount a case-insensitive volume. CI runs the tests on
 * ubuntu only, where this is false and the gated test skips.
 */
const filesystemIsCaseInsensitive: boolean = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), "trust-envelope-case-probe-"));
  try {
    mkdirSync(join(probeRoot, "CaseProbe"));
    return statSync(join(probeRoot, "caseprobe"), { throwIfNoEntry: false }) !== undefined;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

const itOnCaseInsensitiveFilesystem = it.skipIf(!filesystemIsCaseInsensitive);

// Real-filesystem fixtures

/**
 * One temp tree holding a mount, what a bind may legitimately reach inside it, and every shape
 * that tries to leave it. The mount is the repository `repo` and its prefix-colliding sibling
 * `repo-evil`; `other-mount` is another repository.
 */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mountRoot: string;
  readonly realSubdirectory: string;
  readonly symlinkInsideMount: string;
  readonly outsideDirectory: string;
  readonly outsideChild: string;
  readonly prefixCollisionRoot: string;
  readonly secondMountRoot: string;
  readonly secondMountChild: string;
  /** A linked worktree of `repo` beside it, holding `child` and a symlink out. */
  readonly linkedWorktreeRoot: string;
  readonly linkedWorktreeChild: string;
  /** A linked worktree of `repo` nested beneath it, which git lists. */
  readonly nestedListedWorktreeRoot: string;
  /** A folder beneath `repo` whose `.git` file names `repo`'s git directory; git lists it not. */
  readonly nestedUnlistedWorktreeRoot: string;
}

let fixtures: Fixtures;

beforeAll(async () => {
  // Expectations compare against physical paths, and on macOS `/var` is a symlink to
  // `/private/var`, so the root is resolved with the module's own primitive.
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "trust-envelope-")));

  const mountRoot = join(fixtureRoot, "repo");
  const realSubdirectory = join(mountRoot, "real-sub");
  const outsideDirectory = join(fixtureRoot, "outside");
  const outsideChild = join(outsideDirectory, "child");
  const prefixCollisionRoot = join(fixtureRoot, "repo-evil");
  const secondMountRoot = join(fixtureRoot, "other-mount");
  const secondMountChild = join(secondMountRoot, "sub");

  await mkdir(join(mountRoot, "nested", "deep"), { recursive: true });
  await mkdir(realSubdirectory);
  await mkdir(outsideChild, { recursive: true });
  await mkdir(join(fixtureRoot, "sibling"));
  await mkdir(prefixCollisionRoot);
  await mkdir(secondMountChild, { recursive: true });

  await writeFile(join(mountRoot, "README.md"), "mount content\n", "utf8");

  // One symlink that stays inside the mount and one whose spelling stays inside but which leaves.
  const symlinkInsideMount = join(mountRoot, "link-inside");
  await symlink(realSubdirectory, symlinkInsideMount);
  await symlink(outsideDirectory, join(mountRoot, "link-outside"));

  const environment = buildFixtureEnvironment(fixtureRoot);
  const git = (args: readonly string[]): Promise<string> =>
    runFixtureGit(args, environment, fixtureRoot);
  await git(["init", "-q", mountRoot]);
  await git(["-C", mountRoot, "commit", "-q", "--allow-empty", "-m", "seed"]);
  await git(["init", "-q", secondMountRoot]);

  const linkedWorktreeRoot = join(fixtureRoot, "linked-worktree");
  const linkedWorktreeChild = join(linkedWorktreeRoot, "child");
  await git(["-C", mountRoot, "worktree", "add", "-q", "-b", "linked", linkedWorktreeRoot]);
  await mkdir(linkedWorktreeChild);
  await symlink(outsideDirectory, join(linkedWorktreeRoot, "link-outside"));

  const nestedListedWorktreeRoot = join(mountRoot, "nested-listed");
  await git(["-C", mountRoot, "worktree", "add", "-q", "-b", "nested", nestedListedWorktreeRoot]);
  const nestedUnlistedWorktreeRoot = join(mountRoot, "nested-unlisted");
  await mkdir(nestedUnlistedWorktreeRoot);
  await writeFile(
    join(nestedUnlistedWorktreeRoot, ".git"),
    `gitdir: ${join(mountRoot, ".git")}\n`,
    "utf8",
  );

  fixtures = {
    fixtureRoot,
    environment,
    mountRoot,
    realSubdirectory,
    symlinkInsideMount,
    outsideDirectory,
    outsideChild,
    prefixCollisionRoot,
    secondMountRoot,
    secondMountChild,
    linkedWorktreeRoot,
    linkedWorktreeChild,
    nestedListedWorktreeRoot,
    nestedUnlistedWorktreeRoot,
  };
}, 120_000);

afterAll(async () => {
  if (fixtures !== undefined) {
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

// Helpers

/** A validator over real git and the real filesystem, as the daemon builds it. */
function realValidator(): TrustEnvelopeValidator {
  return new TrustEnvelopeValidator({ workingTrees: new RepoRootResolver() });
}

/**
 * Git's answers over a synthetic filesystem: the working tree each spelled path sits in, and the
 * repository's list. An unmapped path sits in no working tree.
 */
function syntheticWorkingTrees(
  workingTreeByPath: Record<string, string>,
  listedWorkingTrees: readonly string[] = [],
): WorkingTreeReader {
  return {
    readWorkingTreeRoot: (directory: string) =>
      Promise.resolve(workingTreeByPath[directory] ?? null),
    listWorkingTrees: () => Promise.resolve(listedWorkingTrees),
  };
}

/** A bind against the fixture mount, with that mount as the whole envelope. */
function candidateInMount(directory?: string): WorkspaceExecutionRootCandidate {
  return {
    mountCanonicalRoot: fixtures.mountRoot,
    directory,
    attachedMountRoots: [fixtures.mountRoot],
  };
}

/** Asserts the rejection is a `TrustEnvelopeViolationError` with the envelope code. */
async function expectEnvelopeRefusal(
  validating: Promise<unknown>,
): Promise<TrustEnvelopeViolationError> {
  const thrown: unknown = await validating.then(
    (value: unknown) => {
      throw new Error(
        `expected TrustEnvelopeViolationError but resolved with ${JSON.stringify(value)}`,
      );
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(TrustEnvelopeViolationError);
  const violation = thrown as TrustEnvelopeViolationError;
  expect(violation.code).toBe("repo.outside_trust_envelope");
  return violation;
}

/**
 * A `realpath` over a synthetic filesystem, mapping spelled path to physical path. An unmapped
 * path rejects like a missing one. `recorded`, when supplied, collects every spelling asked for,
 * so a test can assert a refusal happened before the filesystem.
 */
function syntheticRealpath(
  physicalPathBySpelling: Record<string, string>,
  recorded?: string[],
): PathRealpathResolver {
  return (path: string): Promise<string> => {
    recorded?.push(path);
    const physicalPath = physicalPathBySpelling[path];
    if (physicalPath === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }));
    }
    return Promise.resolve(physicalPath);
  };
}

/** The synthetic filesystem models openable directories only, so its probe always opens. */
describe("envelope admission", () => {
  it("refuses an anchor the attached roots do not contain", async () => {
    // A real mount root that is not attached, such as one detached mid-bind. Containment within
    // it would succeed, so only admission can refuse it.
    await expectEnvelopeRefusal(
      realValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
  });
});

describe("accepted execution roots", () => {
  it("accepts the mount root itself when no directory is supplied", async () => {
    const validated = await realValidator().validateExecutionRoot(candidateInMount());
    expect(validated).toEqual({
      executionRoot: fixtures.mountRoot,
      checkoutRoot: fixtures.mountRoot,
    });
  });

  it("returns a subdirectory reached through an inside symlink SYMLINK-RESOLVED", async () => {
    // A validator that skipped `realpath` would return the alias spelling, which is also
    // contained, so only this assertion proves resolution ran.
    const validated = await realValidator().validateExecutionRoot(candidateInMount("link-inside"));
    expect(validated.executionRoot).toBe(fixtures.realSubdirectory);
    expect(validated.executionRoot).not.toBe(fixtures.symlinkInsideMount);
    expect(validated.checkoutRoot).toBe(fixtures.mountRoot);
  });

  itOnCaseInsensitiveFilesystem(
    "accepts a mis-cased directory and returns the on-disk spelling",
    async () => {
      // Containment compares components case-sensitively off win32, so this binds only because
      // `realpath` first rewrites the candidate to the on-disk spelling. A JS-walk realpath
      // would keep `REAL-SUB` and refuse a directory that is inside the mount.
      const validated = await realValidator().validateExecutionRoot(candidateInMount("REAL-SUB"));
      expect(validated.executionRoot).toBe(fixtures.realSubdirectory);
    },
  );
});

describe("an unusable execution root is refused", () => {
  it("refuses a regular file inside the mount root", async () => {
    // The result is stored as the root a process later runs inside, and nothing else checks it.
    await expectEnvelopeRefusal(
      realValidator().validateExecutionRoot(candidateInMount("README.md")),
    );
  });
});

describe("escapes from the mount root are refused", () => {
  it("refuses an escape into ANOTHER attached mount", async () => {
    // A bind is scoped to its own mount, so a result inside the envelope but outside that mount
    // is still refused.
    const envelope = [fixtures.mountRoot, fixtures.secondMountRoot];
    const validator = realValidator();

    // Positive control: the same target anchored on its own mount is accepted.
    expect(
      (
        await validator.validateExecutionRoot({
          mountCanonicalRoot: fixtures.secondMountRoot,
          directory: "sub",
          attachedMountRoots: envelope,
        })
      ).executionRoot,
    ).toBe(fixtures.secondMountChild);

    await expectEnvelopeRefusal(
      validator.validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        directory: join("..", "other-mount", "sub"),
        attachedMountRoots: envelope,
      }),
    );
  });

  it("refuses a candidate the filesystem will not resolve", async () => {
    // Fail closed: containment cannot be proven for a path that does not resolve.
    await expectEnvelopeRefusal(
      realValidator().validateExecutionRoot(candidateInMount("does-not-exist")),
    );
  });

  it("never returns a root outside the mount for ANY of the adversarial inputs", async () => {
    // `link-outside/..` resolves to the parent of the link's target, outside, although
    // `path.resolve` would collapse it to the mount root; `repo-evil` is not within `repo`.
    const adversarialDirectories = [
      "../sibling",
      "../repo-evil",
      "..",
      "link-outside",
      "link-outside/child",
      "link-outside/..",
      fixtures.outsideDirectory,
      fixtures.outsideChild,
      fixtures.prefixCollisionRoot,
      "nested/../../outside",
    ];
    const validator = realValidator();
    for (const directory of adversarialDirectories) {
      const outcome: unknown = await validator
        .validateExecutionRoot(candidateInMount(directory))
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      expect(outcome, `directory ${directory} was not refused`).toBeInstanceOf(
        TrustEnvelopeViolationError,
      );
    }
  });

  it("leaks no path into the message or the wire detail", async () => {
    // The error must not echo the attempted path, including in `fields`. The carrier takes only a
    // closed reason, so this checks the validator found no other way to attach one.
    const violation = await expectEnvelopeRefusal(
      realValidator().validateExecutionRoot(candidateInMount("link-outside")),
    );
    expect(violation.message).not.toContain(fixtures.fixtureRoot);
    expect(violation.message).not.toContain("link-outside");
    expect(violation.detail).toEqual({ reason: "outside_project" });
    // Positive control: the spread carries the own properties, so the negative check cannot pass
    // vacuously if they moved onto the prototype.
    expect(JSON.stringify({ ...violation })).toContain("repo.outside_trust_envelope");
    expect(JSON.stringify({ ...violation })).not.toContain(fixtures.fixtureRoot);
  });
});

describe("win32 path shapes", () => {
  // Injecting `path.win32` and a synthetic filesystem makes the Windows branch run on any host.

  const WINDOWS_MOUNT_ROOT = "C:\\repos\\app";

  function windowsValidator(
    physicalPathBySpelling: Record<string, string>,
    recorded?: string[],
    workingTreeByPath: Record<string, string> = {},
  ): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: win32Path,
      realpath: syntheticRealpath(physicalPathBySpelling, recorded),
      probeDirectoryReadable: alwaysReadableProbe,
      workingTrees: syntheticWorkingTrees(workingTreeByPath),
    });
  }

  it("refuses the forward-slash spelling even when the drive completes it INSIDE", async () => {
    // `/evil` names no volume, so only the daemon's current drive could complete it. Here that
    // drive puts it inside the mount, where containment would accept it; the gate refuses it.
    await expectEnvelopeRefusal(
      windowsValidator({ "/evil": "C:\\repos\\app\\evil" }).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "/evil",
        attachedMountRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
  });

  it("refuses a drive-RELATIVE envelope entry as an admission proof", async () => {
    // `C:` and `C:\` both reduce to the component `c:`, so without the envelope-entry guard `C:`
    // would admit a drive-root anchor.
    await expectEnvelopeRefusal(
      windowsValidator({ "C:\\": "C:\\" }).validateExecutionRoot({
        mountCanonicalRoot: "C:\\",
        attachedMountRoots: ["C:"],
      }),
    );
  });

  it("refuses a drive-RELATIVE anchor before the filesystem sees it", async () => {
    // The mirror image, caught by the anchor guard: without it admission would pass and the join
    // would proceed drive-relative.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      windowsValidator({ "C:": "C:\\somewhere" }, recorded).validateExecutionRoot({
        mountCanonicalRoot: "C:",
        attachedMountRoots: ["C:\\"],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("accepts a candidate whose physical spelling differs only in case", async () => {
    const validated = await windowsValidator(
      { "C:\\repos\\app\\Src": "C:\\Repos\\App\\Src" },
      undefined,
      { "C:\\Repos\\App\\Src": "C:\\Repos\\App" },
    ).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      directory: "Src",
      attachedMountRoots: [WINDOWS_MOUNT_ROOT],
    });
    // Folding applies to the comparison only; the returned root keeps the filesystem's spelling.
    expect(validated.executionRoot).toBe("C:\\Repos\\App\\Src");
  });

  it("admits an anchor whose envelope entry differs only in case", async () => {
    const validated = await windowsValidator({ "C:\\repos\\app": "C:\\repos\\app" }, undefined, {
      "C:\\repos\\app": "C:\\repos\\app",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      attachedMountRoots: ["C:\\REPOS\\APP"],
    });
    expect(validated.executionRoot).toBe(WINDOWS_MOUNT_ROOT);
  });
});

describe("case folding stays win32-scoped", () => {
  // A folding rule that leaked onto POSIX, where a filesystem may be case-sensitive, shows here.

  const POSIX_MOUNT_ROOT = "/repos/app";

  function posixValidator(physicalPathBySpelling: Record<string, string>): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: posixPath,
      realpath: syntheticRealpath(physicalPathBySpelling),
      probeDirectoryReadable: alwaysReadableProbe,
      // The folder sits in a working tree spelled like the mount in another case, which git lists
      // under the mount's own spelling.
      workingTrees: syntheticWorkingTrees({ "/Repos/App/Src": "/Repos/App" }, [POSIX_MOUNT_ROOT]),
    });
  }

  it("refuses a candidate whose physical spelling differs only in case", async () => {
    await expectEnvelopeRefusal(
      posixValidator({ "/repos/app/Src": "/Repos/App/Src" }).validateExecutionRoot({
        mountCanonicalRoot: POSIX_MOUNT_ROOT,
        directory: "Src",
        attachedMountRoots: [POSIX_MOUNT_ROOT],
      }),
    );
  });
});

describe("working trees git lists for the mount's repository", () => {
  it("admits a listed worktree and a folder inside it, with the worktree as checkout", async () => {
    const validator = realValidator();
    for (const directory of [fixtures.linkedWorktreeRoot, fixtures.linkedWorktreeChild]) {
      expect(await validator.validateExecutionRoot(candidateInMount(directory))).toEqual({
        executionRoot: directory,
        checkoutRoot: fixtures.linkedWorktreeRoot,
      });
    }
  });

  it("refuses traversal and symlink escapes from inside a listed worktree", async () => {
    const validator = realValidator();
    for (const directory of [
      // Spelled, not joined: `path.join` would collapse the `..` before the filesystem saw it.
      `${fixtures.linkedWorktreeRoot}/..`,
      `${fixtures.linkedWorktreeRoot}/child/../../outside`,
      join(fixtures.linkedWorktreeRoot, "link-outside"),
      join(fixtures.linkedWorktreeRoot, "link-outside", "child"),
    ]) {
      await expectEnvelopeRefusal(validator.validateExecutionRoot(candidateInMount(directory)));
    }
  });

  it("refuses an unlisted sibling folder and a working tree of another repository", async () => {
    const validator = realValidator();
    for (const directory of [
      fixtures.outsideDirectory,
      fixtures.secondMountRoot,
      fixtures.secondMountChild,
    ]) {
      await expectEnvelopeRefusal(validator.validateExecutionRoot(candidateInMount(directory)));
    }
  });

  it("refuses a nested working tree git does not list, while its listed twin admits", async () => {
    // Both sit beneath the mount root, so containment alone would admit both.
    const validator = realValidator();
    await expectEnvelopeRefusal(
      validator.validateExecutionRoot(candidateInMount("nested-unlisted")),
    );
    expect(await validator.validateExecutionRoot(candidateInMount("nested-listed"))).toEqual({
      executionRoot: fixtures.nestedListedWorktreeRoot,
      checkoutRoot: fixtures.nestedListedWorktreeRoot,
    });
  });

  it("reads git's list at every pick, never a remembered one", async () => {
    const worktreeRoot = join(fixtures.fixtureRoot, "listed-then-dropped");
    await runFixtureGit(
      ["-C", fixtures.mountRoot, "worktree", "add", "-q", "-b", "dropped", worktreeRoot],
      fixtures.environment,
      fixtures.fixtureRoot,
    );
    const validator = realValidator();
    expect(
      (await validator.validateExecutionRoot(candidateInMount(worktreeRoot))).checkoutRoot,
    ).toBe(worktreeRoot);

    // Git stops listing the worktree; its folder still answers as a working tree of the
    // repository, so only a fresh read of the list refuses it.
    await rm(join(fixtures.mountRoot, ".git", "worktrees", "listed-then-dropped"), {
      recursive: true,
      force: true,
    });
    await writeFile(join(worktreeRoot, ".git"), `gitdir: ${join(fixtures.mountRoot, ".git")}\n`);

    await expectEnvelopeRefusal(validator.validateExecutionRoot(candidateInMount(worktreeRoot)));
  });
});

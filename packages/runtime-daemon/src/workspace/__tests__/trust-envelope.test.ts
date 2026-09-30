// Adversarial containment tests for the bind-time trust-envelope validator.
//
// The invariant: no input (traversal, symlink escape, prefix collision, absolute redirection, a
// foreign anchor or an unresolvable path) yields a validated root outside the canonical root of
// an attached mount. Containment is symlink-resolved, aware of path-component boundaries
// (`/repo-evil` is not within `/repo`) and case-folded only on win32.
//
// Real temp directories, symlinks and permission modes cover everything a POSIX filesystem can
// express, so ordering is asserted against the kernel's own symlink resolution. Three injected
// seams (`realpath`, `probeDirectoryReadable`, `platformPath`) cover what this host cannot
// produce: win32 path shapes, case folding, and a resolved root whose type or readability
// differs from what the host would report. A mode bit does nothing under root, which CI
// containers often are, so each real-mode case has a seam-driven twin that runs everywhere.
//
// Case sensitivity is never read off the host: macOS APFS is usually case-insensitive and CI's
// ext4 is not, so a test that created `Repo` and looked for `repo` would pass on one and fail on
// the other. Every case-folding assertion runs through `platformPath` against a synthetic
// filesystem.

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix as posixPath, sep, win32 as win32Path } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TrustEnvelopeViolationError } from "../repo-errors.js";
import {
  DEFAULT_REALPATH,
  TrustEnvelopeValidator,
  type DirectoryReadabilityProbe,
  type PathRealpathResolver,
  type WorkspaceExecutionRootCandidate,
} from "../trust-envelope.js";

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
    statSync(join(probeRoot, "caseprobe"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

const itOnCaseInsensitiveFilesystem = it.skipIf(!filesystemIsCaseInsensitive);

/**
 * Gate for the permission-mode cases: POSIX and not root. Root opens a `0111` directory, so a
 * mode-bit assertion under root would pass while testing nothing.
 */
const itOnPosixAsNonRoot = it.skipIf(process.platform === "win32" || process.geteuid?.() === 0);

// Real-filesystem fixtures

/**
 * One temp tree holding a mount, what a bind may legitimately reach inside it, and every shape
 * that tries to leave it. The mount is `repo` and its prefix-colliding sibling `repo-evil`.
 */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly mountRoot: string;
  readonly nestedDirectory: string;
  readonly realSubdirectory: string;
  readonly symlinkInsideMount: string;
  readonly symlinkEscapingMount: string;
  readonly symlinkToFileInMount: string;
  readonly outsideDirectory: string;
  readonly outsideChild: string;
  readonly siblingDirectory: string;
  readonly prefixCollisionRoot: string;
  readonly prefixCollisionChild: string;
  readonly secondMountRoot: string;
  readonly secondMountChild: string;
  readonly aliasToMountRoot: string;
  readonly regularFileInMount: string;
  readonly unreadableSubdirectory: string;
}

let fixtures: Fixtures;

beforeAll(async () => {
  // Expectations compare against physical paths, and on macOS `/var` is a symlink to
  // `/private/var`. The root is resolved with the module's own primitive,
  // `node:fs/promises.realpath`, so a spelling difference cannot look like a module bug.
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "trust-envelope-")));

  const mountRoot = join(fixtureRoot, "repo");
  const nestedDirectory = join(mountRoot, "nested", "deep");
  const realSubdirectory = join(mountRoot, "real-sub");
  const outsideDirectory = join(fixtureRoot, "outside");
  const outsideChild = join(outsideDirectory, "child");
  const siblingDirectory = join(fixtureRoot, "sibling");
  const prefixCollisionRoot = join(fixtureRoot, "repo-evil");
  const prefixCollisionChild = join(prefixCollisionRoot, "inside");
  const secondMountRoot = join(fixtureRoot, "other-mount");
  const secondMountChild = join(secondMountRoot, "sub");

  await mkdir(nestedDirectory, { recursive: true });
  await mkdir(realSubdirectory);
  await mkdir(outsideChild, { recursive: true });
  await mkdir(siblingDirectory);
  await mkdir(prefixCollisionChild, { recursive: true });
  await mkdir(secondMountChild, { recursive: true });

  const regularFileInMount = join(mountRoot, "README.md");
  await writeFile(regularFileInMount, "mount content\n", "utf8");

  // One symlink that stays inside the mount (accepted, returned resolved) and one that leaves it
  // (refused even though its spelling stays inside).
  const symlinkInsideMount = join(mountRoot, "link-inside");
  const symlinkEscapingMount = join(mountRoot, "link-outside");
  await symlink(realSubdirectory, symlinkInsideMount);
  await symlink(outsideDirectory, symlinkEscapingMount);

  // A symlink that stays inside the mount and resolves to a regular file, so only the directory
  // check can refuse it.
  const symlinkToFileInMount = join(mountRoot, "link-to-file");
  await symlink(regularFileInMount, symlinkToFileInMount);

  // An alias for the mount root: what a caller passes for a root that was never `realpath`-ed,
  // and what an attacker produces by replacing an admitted root with a link.
  const aliasToMountRoot = join(fixtureRoot, "alias-to-repo");
  await symlink(mountRoot, aliasToMountRoot);

  // A directory inside the mount that can be traversed but not listed: contained and resolvable,
  // so only the readability probe can refuse it. It sits under a readable mount root, which the
  // attach-time check never sees. `afterAll` lifts the mode before the recursive delete, which
  // cannot descend into a `0111` directory. Skipped on win32, where the bits mean something else.
  const unreadableSubdirectory = join(mountRoot, "unreadable-sub");
  await mkdir(unreadableSubdirectory);
  if (process.platform !== "win32") {
    await chmod(unreadableSubdirectory, 0o111);
  }

  fixtures = {
    fixtureRoot,
    mountRoot,
    nestedDirectory,
    realSubdirectory,
    symlinkInsideMount,
    symlinkEscapingMount,
    symlinkToFileInMount,
    outsideDirectory,
    outsideChild,
    siblingDirectory,
    prefixCollisionRoot,
    prefixCollisionChild,
    secondMountRoot,
    secondMountChild,
    aliasToMountRoot,
    regularFileInMount,
    unreadableSubdirectory,
  };
});

afterAll(async () => {
  if (fixtures !== undefined) {
    // Lift the traverse-only mode first: `force: true` suppresses ENOENT, not EACCES, so `rm`
    // would fail and strand the tree. Best-effort, so it cannot mask a real test failure.
    await chmod(fixtures.unreadableSubdirectory, 0o755).catch(() => undefined);
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

// Helpers

/** A bind against the fixture mount, with that mount as the whole envelope. */
function candidateInMount(directory?: string): WorkspaceExecutionRootCandidate {
  return {
    mountCanonicalRoot: fixtures.mountRoot,
    directory,
    attachedMountRoots: [fixtures.mountRoot],
  };
}

/**
 * Asserts the rejection is a `TrustEnvelopeViolationError` with the envelope code. Every refusal
 * in this file goes through it, so the error type is pinned on each case.
 */
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

/** `realpath` that records what it was handed, then answers for real. */
function recordingRealpath(recorded: string[]): PathRealpathResolver {
  return async (path: string): Promise<string> => {
    recorded.push(path);
    return realpath(path);
  };
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

/**
 * A readability probe over the synthetic filesystem, which models openable directories only. A
 * real probe would fail with `ENOENT` on the win32 spellings no host has, and `/srv` exists on
 * Linux but not macOS, so the verdict would depend on the host.
 */
const alwaysReadableProbe: DirectoryReadabilityProbe = () => Promise.resolve();

/**
 * A probe that rejects with a chosen errno, to refuse a candidate that satisfies every other
 * rule: `ENOTDIR` for a root that is not a directory, `EACCES` for one that will not be listed.
 */
function rejectingProbe(errnoCode: string): DirectoryReadabilityProbe {
  return () => Promise.reject(Object.assign(new Error(errnoCode), { code: errnoCode }));
}

// Envelope admission

describe("envelope admission", () => {
  // The anchor a bind names must be one of the attached canonical roots. Membership is equality,
  // so "attached" is something the validator checks rather than something the caller asserts.

  it("accepts an anchor that is one of several attached mounts", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot({
      mountCanonicalRoot: fixtures.mountRoot,
      directory: "nested",
      attachedMountRoots: [fixtures.secondMountRoot, fixtures.mountRoot],
    });
    expect(validated).toBe(join(fixtures.mountRoot, "nested"));
  });

  it("refuses an anchor the attached roots do not contain", async () => {
    // A real mount root that is not attached, such as one detached mid-bind. Containment within
    // it would succeed, so only admission can refuse it.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses an anchor that only prefix-collides with an attached root", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.prefixCollisionRoot,
        directory: "inside",
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses an anchor nested INSIDE an attached root — membership is equality", async () => {
    // A subdirectory of an attached mount is inside the envelope but is not a mount root, and
    // admitting it would let a caller narrow the anchor to any directory.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.realSubdirectory,
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses every candidate when no mount is attached", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        attachedMountRoots: [],
      }),
    );
  });

  it("refuses a foreign anchor without touching the filesystem", async () => {
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({ realpath: recordingRealpath(recorded) }).validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a relative anchor before it can be completed from the daemon's cwd", async () => {
    // `realpath` would resolve `repo` against the daemon's working directory and return a
    // plausible root unrelated to any mount.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({ realpath: recordingRealpath(recorded) }).validateExecutionRoot({
        mountCanonicalRoot: "repo",
        directory: "nested",
        attachedMountRoots: ["repo"],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a relative envelope entry as an admission proof", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        attachedMountRoots: ["repo"],
      }),
    );
  });
});

describe("accepted execution roots", () => {
  it("accepts the mount root itself when no directory is supplied", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount());
    expect(validated).toBe(fixtures.mountRoot);
  });

  it("treats an empty directory as the mount root", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount(""),
    );
    expect(validated).toBe(fixtures.mountRoot);
  });

  it("accepts a nested subdirectory inside the mount root", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount(join("nested", "deep")),
    );
    expect(validated).toBe(fixtures.nestedDirectory);
  });

  it("returns a subdirectory reached through an inside symlink SYMLINK-RESOLVED", async () => {
    // A validator that skipped `realpath` would return the alias spelling, which is also
    // contained, so only this assertion proves resolution ran.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount("link-inside"),
    );
    expect(validated).toBe(fixtures.realSubdirectory);
    expect(validated).not.toBe(fixtures.symlinkInsideMount);
  });

  itOnCaseInsensitiveFilesystem(
    "accepts a mis-cased directory and returns the on-disk spelling",
    async () => {
      // Containment compares components case-sensitively off win32, so this binds only because
      // `realpath` first rewrites the candidate to the on-disk spelling. A JS-walk realpath
      // would keep `REAL-SUB` and refuse a directory that is inside the mount.
      const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
        candidateInMount("REAL-SUB"),
      );
      expect(validated).toBe(fixtures.realSubdirectory);
    },
  );

  it("accepts an absolute directory that stays inside the mount root", async () => {
    // Only absolute redirection outside the mount is refused; the boundary is containment, not
    // how the path is spelled.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount(fixtures.realSubdirectory),
    );
    expect(validated).toBe(fixtures.realSubdirectory);
  });

  it("accepts `..` that stays inside the mount", async () => {
    // Spelled literally: `join` would collapse the `..` before the filesystem saw it.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount("nested/deep/.."),
    );
    expect(validated).toBe(join(fixtures.mountRoot, "nested"));
  });
});

// The resolved root must be a directory the daemon can enumerate

describe("an unusable execution root is refused", () => {
  // Contained but unusable in two ways. The result is stored as `workspaces.fs_root`, a root a
  // process is later run inside, and nothing else checks it. A regular file would persist a
  // workspace that can never spawn, and a `0111` directory one that can never be listed. One
  // open-for-enumeration probe refuses both.

  it("refuses a regular file inside the mount root", async () => {
    // Real filesystem with no seam, so it runs on every host including CI; the probe refuses it
    // with `ENOTDIR`.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("README.md")),
    );
  });

  it("refuses a symlink inside the mount that RESOLVES to a regular file", async () => {
    // The check runs on the resolved value: the spelling names a symlink and only its target is
    // a file.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-to-file")),
    );
  });

  it("resolves `link-to-file` inside the mount, so its refusal is not an escape", async () => {
    // The premise of the test above: without it, that refusal could be an escape or an
    // unresolvable path instead of the type check.
    const resolvedTarget = await realpath(fixtures.symlinkToFileInMount);
    expect(resolvedTarget).toBe(fixtures.regularFileInMount);
    expect(resolvedTarget.startsWith(`${fixtures.mountRoot}${sep}`)).toBe(true);
  });

  it("refuses a resolved root the probe rejects as a non-directory", async () => {
    // Only the probe varies between the two runs below, so the verdict is the probe's alone.
    const windowsCandidate: WorkspaceExecutionRootCandidate = {
      mountCanonicalRoot: "C:\\repos\\app",
      directory: "pkg",
      attachedMountRoots: ["C:\\repos\\app"],
    };
    const physicalPathBySpelling = { "C:\\repos\\app\\pkg": "C:\\repos\\app\\pkg" };

    // Positive control: the same setup with a probe that opens is accepted.
    expect(
      await new TrustEnvelopeValidator({
        platformPath: win32Path,
        realpath: syntheticRealpath(physicalPathBySpelling),
        probeDirectoryReadable: alwaysReadableProbe,
      }).validateExecutionRoot(windowsCandidate),
    ).toBe("C:\\repos\\app\\pkg");

    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({
        platformPath: win32Path,
        realpath: syntheticRealpath(physicalPathBySpelling),
        probeDirectoryReadable: rejectingProbe("ENOTDIR"),
      }).validateExecutionRoot(windowsCandidate),
    );
  });

  it("refuses a contained directory that cannot be LISTED", async () => {
    // Driven through the seam so it runs on every platform and uid; the real-mode twin is below.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({
        probeDirectoryReadable: rejectingProbe("EACCES"),
      }).validateExecutionRoot(candidateInMount()),
    );
  });

  itOnPosixAsNonRoot("refuses a real `0111` subdirectory of the mount", async () => {
    // Mode `0111` allows traversal but not listing, so `realpath` and containment pass and only
    // the readability probe refuses. Without it a bind would persist a `fs_root` the daemon can
    // never enumerate, under a readable mount root.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("unreadable-sub")),
    );
  });

  itOnPosixAsNonRoot("accepts that same subdirectory once it can be listed", async () => {
    // Control for the test above: same path, only the permission bits differ.
    await chmod(fixtures.unreadableSubdirectory, 0o755);
    try {
      expect(
        await new TrustEnvelopeValidator().validateExecutionRoot(
          candidateInMount("unreadable-sub"),
        ),
      ).toBe(fixtures.unreadableSubdirectory);
    } finally {
      await chmod(fixtures.unreadableSubdirectory, 0o111);
    }
  });
});

// Traversal, symlink escape, prefix collision, absolute redirection

describe("escapes from the mount root are refused", () => {
  it("has real escape targets, so the refusals below are about containment", async () => {
    // Otherwise a refusal could mean the target did not exist, and the section would pass
    // against a validator that never checked a boundary.
    expect(await realpath(fixtures.siblingDirectory)).toBe(fixtures.siblingDirectory);
    expect(await realpath(fixtures.outsideDirectory)).toBe(fixtures.outsideDirectory);
    expect(await realpath(fixtures.prefixCollisionChild)).toBe(fixtures.prefixCollisionChild);
    expect(await realpath(fixtures.symlinkEscapingMount)).toBe(fixtures.outsideDirectory);
  });

  it("refuses `../sibling` traversal", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("../sibling")),
    );
  });

  it("refuses traversal that climbs out through a real subdirectory", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("nested/../../sibling")),
    );
  });

  it("refuses a directory that IS a symlink pointing outside the mount", async () => {
    // The spelling never leaves the mount, so only a check after symlink resolution catches it.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-outside")),
    );
  });

  it("refuses a chain that descends through an escaping symlink", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(
        candidateInMount(join("link-outside", "child")),
      ),
    );
  });

  it("refuses `..` applied to an escaping symlink's target", async () => {
    // `path.resolve(mountRoot, "link-outside/..")` collapses to the mount root, but the kernel
    // resolves it to the parent of the link's target, which is outside. The validator must
    // agree with the kernel, since a later `open()` will.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-outside/..")),
    );
  });

  it("refuses a prefix-colliding sibling reached by traversal", async () => {
    // `/repo-evil` is not within `/repo`: the boundary is a path component, not a string prefix.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("../repo-evil")),
    );
  });

  it("refuses a prefix-colliding sibling named absolutely", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(
        candidateInMount(fixtures.prefixCollisionChild),
      ),
    );
  });

  it("refuses absolute redirection outside the mount root", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(
        candidateInMount(fixtures.outsideDirectory),
      ),
    );
  });

  it("refuses the mount root's own parent", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("..")),
    );
  });

  it("refuses an escape into ANOTHER attached mount", async () => {
    // A bind is scoped to its own mount, so a result inside the envelope but outside that mount
    // is still refused.
    const envelope = [fixtures.mountRoot, fixtures.secondMountRoot];
    const validator = new TrustEnvelopeValidator();

    // Positive control: the same target anchored on its own mount is accepted.
    expect(
      await validator.validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        attachedMountRoots: envelope,
      }),
    ).toBe(fixtures.secondMountChild);

    await expectEnvelopeRefusal(
      validator.validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        directory: join("..", "other-mount", "sub"),
        attachedMountRoots: envelope,
      }),
    );
  });

  it("refuses an anchor handed over as an alias rather than its canonical root", async () => {
    // The validator never re-resolves the anchor: doing so would make an admitted root later
    // replaced by a symlink agree with its new target. The cost is refusing a caller's
    // un-canonicalized root, which production never passes.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.aliasToMountRoot,
        directory: "nested",
        attachedMountRoots: [fixtures.aliasToMountRoot],
      }),
    );
  });

  it("refuses an aliased anchor even with no directory at all", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.aliasToMountRoot,
        attachedMountRoots: [fixtures.aliasToMountRoot],
      }),
    );
  });

  it("refuses a candidate the filesystem will not resolve", async () => {
    // Fail closed: containment cannot be proven for a path that does not resolve. A vanished
    // mount root therefore reports as an envelope violation rather than `stale`, as the module
    // header notes.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("does-not-exist")),
    );
  });

  it("refuses a candidate whose spelling the filesystem rejects outright", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("nul\u0000byte")),
    );
  });

  it("never returns a root outside the mount for ANY of the adversarial inputs", async () => {
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
    const validator = new TrustEnvelopeValidator();
    for (const directory of adversarialDirectories) {
      const outcome: unknown = await validator
        .validateExecutionRoot(candidateInMount(directory))
        .then(
          (value: string) => value,
          (error: unknown) => error,
        );
      expect(outcome, `directory ${directory} was not refused`).toBeInstanceOf(
        TrustEnvelopeViolationError,
      );
    }
  });
});

// Resolution order: resolve, then contain

describe("the filesystem resolves before the boundary check runs", () => {
  it("hands the filesystem the spelled candidate, not a lexically collapsed one", async () => {
    // `path.resolve` would apply `..` first and rename the target; joining raw lets the kernel
    // apply `..` to the link's resolved target.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({ realpath: recordingRealpath(recorded) }).validateExecutionRoot(
        candidateInMount("link-outside/.."),
      ),
    );
    expect(recorded).toEqual([`${fixtures.mountRoot}${sep}link-outside${sep}..`]);
  });

  it("resolves the mount root itself rather than short-circuiting on it", async () => {
    const recorded: string[] = [];
    await new TrustEnvelopeValidator({
      realpath: recordingRealpath(recorded),
    }).validateExecutionRoot(candidateInMount());
    expect(recorded).toEqual([fixtures.mountRoot]);
  });

  it("hands an absolute directory to the filesystem as given", async () => {
    const recorded: string[] = [];
    await new TrustEnvelopeValidator({
      realpath: recordingRealpath(recorded),
    }).validateExecutionRoot(candidateInMount(fixtures.realSubdirectory));
    expect(recorded).toEqual([fixtures.realSubdirectory]);
  });
});

// The refusal carrier: typed and path-free

describe("refusals carry the typed, path-free error", () => {
  it("throws the registry-canonical code and notional status", async () => {
    const violation = await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("../sibling")),
    );
    expect(violation.code).toBe("repo.outside_trust_envelope");
    expect(violation.httpStatus).toBe(403);
    expect(violation.name).toBe("TrustEnvelopeViolationError");
  });

  it("leaks no path into the message or the wire detail", async () => {
    // The error must not echo the attempted path, including in `fields`. The carrier takes no
    // arguments, so this checks the validator found no other way to attach one.
    const violation = await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-outside")),
    );
    expect(violation.message).not.toContain(fixtures.fixtureRoot);
    expect(violation.message).not.toContain("link-outside");
    expect(violation.detail).toBeUndefined();
    // Positive control: the spread carries the own properties, so the negative check cannot pass
    // vacuously if they moved onto the prototype.
    expect(JSON.stringify({ ...violation })).toContain("repo.outside_trust_envelope");
    expect(JSON.stringify({ ...violation })).not.toContain(fixtures.fixtureRoot);
  });
});

// win32 comparison semantics, driven from POSIX CI

describe("win32 case folding and root shapes", () => {
  // Injecting `path.win32` makes the Windows branch observable on an ubuntu runner, and the
  // synthetic filesystem keeps it independent of the host's case sensitivity.

  const WINDOWS_MOUNT_ROOT = "C:\\repos\\app";

  function windowsValidator(
    physicalPathBySpelling: Record<string, string>,
    recorded?: string[],
  ): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: win32Path,
      realpath: syntheticRealpath(physicalPathBySpelling, recorded),
      probeDirectoryReadable: alwaysReadableProbe,
    });
  }

  it("accepts a candidate whose physical spelling differs only in case", async () => {
    const validated = await windowsValidator({
      "C:\\repos\\app\\Src": "C:\\Repos\\App\\Src",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      directory: "Src",
      attachedMountRoots: [WINDOWS_MOUNT_ROOT],
    });
    // Folding applies to the comparison only; the returned root keeps the filesystem's spelling.
    expect(validated).toBe("C:\\Repos\\App\\Src");
  });

  it("admits an anchor whose envelope entry differs only in case", async () => {
    const validated = await windowsValidator({
      "C:\\repos\\app": "C:\\repos\\app",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      attachedMountRoots: ["C:\\REPOS\\APP"],
    });
    expect(validated).toBe(WINDOWS_MOUNT_ROOT);
  });

  it("refuses a case-folded prefix collision", async () => {
    // Folding must not soften the component boundary: `C:\repos\app-evil` is not within
    // `C:\repos\app`.
    await expectEnvelopeRefusal(
      windowsValidator({
        "C:\\repos\\app\\out": "C:\\Repos\\App-Evil\\out",
      }).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "out",
        attachedMountRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
  });

  it("refuses a driveless absolute directory before the filesystem sees it", async () => {
    // `\evil` is absolute to `path.win32` but names no volume, so only the daemon's current drive
    // could complete it and the verdict would depend on ambient state. The join refuses the shape
    // outright, before any resolution.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      windowsValidator({ "\\evil": "C:\\evil" }, recorded).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "\\evil",
        attachedMountRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses the forward-slash spelling even when the drive completes it INSIDE", async () => {
    // Here the synthetic current drive puts `/evil` inside the mount, so containment would accept
    // it, while a daemon on another drive would refuse it. The gate refuses it either way.
    await expectEnvelopeRefusal(
      windowsValidator({ "/evil": "C:\\repos\\app\\evil" }).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "/evil",
        attachedMountRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
  });

  it("still admits a drive-complete absolute directory inside the mount", async () => {
    // Only the drive-less shape is refused; a complete absolute path inside the mount is accepted.
    const validated = await windowsValidator({
      "C:\\repos\\app\\pkg": "C:\\repos\\app\\pkg",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      directory: "C:\\repos\\app\\pkg",
      attachedMountRoots: [WINDOWS_MOUNT_ROOT],
    });
    expect(validated).toBe("C:\\repos\\app\\pkg");
  });

  it("refuses a drive-RELATIVE envelope entry as an admission proof", async () => {
    // `C:` is not absolute to `path.win32`, and only the envelope-entry guard separates it from
    // `C:\`: both reduce to the component `c:`, so without the guard it would admit a drive-root
    // anchor.
    await expectEnvelopeRefusal(
      windowsValidator({ "C:\\": "C:\\" }).validateExecutionRoot({
        mountCanonicalRoot: "C:\\",
        attachedMountRoots: ["C:"],
      }),
    );
  });

  it("refuses a drive-RELATIVE anchor before the filesystem sees it", async () => {
    // The mirror image, caught by the anchor guard: the components of `C:` and `C:\` match, so
    // without it admission would pass and the join would proceed drive-relative.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      windowsValidator({ "C:": "C:\\somewhere" }, recorded).validateExecutionRoot({
        mountCanonicalRoot: "C:",
        attachedMountRoots: ["C:\\"],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a resolved root that is drive-relative under a drive-root anchor", async () => {
    // Containment alone cannot carry absoluteness for a bare-root anchor: `C:\` and a resolved
    // `C:` both reduce to `["c:"]`. A real `realpath` never returns that, so this pins the
    // absoluteness backstop, not a reachable production path.
    await expectEnvelopeRefusal(
      windowsValidator({ "C:\\": "C:" }).validateExecutionRoot({
        mountCanonicalRoot: "C:\\",
        attachedMountRoots: ["C:\\"],
      }),
    );
  });

  it("contains a subdirectory under a UNC share root", async () => {
    const uncRoot = "\\\\server\\share\\repo";
    const validated = await windowsValidator({
      "\\\\server\\share\\repo\\pkg": "\\\\server\\share\\repo\\pkg",
    }).validateExecutionRoot({
      mountCanonicalRoot: uncRoot,
      directory: "pkg",
      attachedMountRoots: [uncRoot],
    });
    expect(validated).toBe("\\\\server\\share\\repo\\pkg");
  });

  it("refuses a different share under the same server", async () => {
    await expectEnvelopeRefusal(
      windowsValidator({
        "\\\\server\\share\\repo\\pkg": "\\\\server\\other\\repo\\pkg",
      }).validateExecutionRoot({
        mountCanonicalRoot: "\\\\server\\share\\repo",
        directory: "pkg",
        attachedMountRoots: ["\\\\server\\share\\repo"],
      }),
    );
  });

  it("joins a drive-root anchor without doubling the separator", async () => {
    const validated = await windowsValidator({
      "C:\\data": "C:\\data",
    }).validateExecutionRoot({
      mountCanonicalRoot: "C:\\",
      directory: "data",
      attachedMountRoots: ["C:\\"],
    });
    expect(validated).toBe("C:\\data");
  });
});

describe("the default realpath implementation is pinned", () => {
  it("is `node:fs/promises.realpath`, never the JS-walk implementation", () => {
    // Deliberately structural. The callback `node:fs` `realpath` does no case conversion on
    // case-insensitive filesystems and collapses `..` in its own walk rather than against a
    // symlink's resolved target, which would reopen the escape. The casing half cannot be
    // observed on ubuntu-only CI, but this assertion fails on every platform.
    expect(DEFAULT_REALPATH).toBe(realpath);
  });
});

describe("case folding stays win32-scoped", () => {
  // The POSIX control: the win32 shapes on the same synthetic filesystem with only the platform
  // changed, so a folding rule that leaked onto POSIX shows up here.

  const POSIX_MOUNT_ROOT = "/repos/app";

  function posixValidator(physicalPathBySpelling: Record<string, string>): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: posixPath,
      realpath: syntheticRealpath(physicalPathBySpelling),
      probeDirectoryReadable: alwaysReadableProbe,
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

  it("refuses an envelope entry that differs only in case", async () => {
    await expectEnvelopeRefusal(
      posixValidator({ "/repos/app": "/repos/app" }).validateExecutionRoot({
        mountCanonicalRoot: POSIX_MOUNT_ROOT,
        attachedMountRoots: ["/REPOS/APP"],
      }),
    );
  });

  it("joins a filesystem-root anchor without doubling the separator", async () => {
    // `//x` is implementation-defined under POSIX, so the join must not produce it.
    const validated = await posixValidator({ "/srv": "/srv" }).validateExecutionRoot({
      mountCanonicalRoot: "/",
      directory: "srv",
      attachedMountRoots: ["/"],
    });
    expect(validated).toBe("/srv");
  });
});

// Proves the trust-envelope validator never returns an execution root outside the attached mount a
// bind names: traversal, symlink escapes, prefix collisions, another mount and drive-less win32
// shapes are refused, an accepted root comes back symlink-resolved, and win32 and case-insensitive
// filesystems compare paths case-folded.

import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TrustEnvelopeViolationError } from "../repo/errors.js";
import {
  TrustEnvelopeValidator,
  type PathRealpathResolver,
  type WorkspaceExecutionRootCandidate,
} from "../trust-envelope.js";

import { alwaysReadableProbe } from "./workspace.test-support.js";

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
 * that tries to leave it. The mount is `repo` and its prefix-colliding sibling `repo-evil`.
 */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly mountRoot: string;
  readonly realSubdirectory: string;
  readonly symlinkInsideMount: string;
  readonly outsideDirectory: string;
  readonly outsideChild: string;
  readonly prefixCollisionRoot: string;
  readonly secondMountRoot: string;
  readonly secondMountChild: string;
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

  fixtures = {
    fixtureRoot,
    mountRoot,
    realSubdirectory,
    symlinkInsideMount,
    outsideDirectory,
    outsideChild,
    prefixCollisionRoot,
    secondMountRoot,
    secondMountChild,
  };
});

afterAll(async () => {
  if (fixtures !== undefined) {
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
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        attachedMountRoots: [fixtures.mountRoot],
      }),
    );
  });
});

describe("accepted execution roots", () => {
  it("accepts the mount root itself when no directory is supplied", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount());
    expect(validated).toBe(fixtures.mountRoot);
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
});

describe("an unusable execution root is refused", () => {
  it("refuses a regular file inside the mount root", async () => {
    // The result is stored as the root a process later runs inside, and nothing else checks it.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("README.md")),
    );
  });
});

describe("escapes from the mount root are refused", () => {
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

  it("refuses a candidate the filesystem will not resolve", async () => {
    // Fail closed: containment cannot be proven for a path that does not resolve.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("does-not-exist")),
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

describe("win32 path shapes", () => {
  // Injecting `path.win32` and a synthetic filesystem makes the Windows branch run on any host.

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
});

describe("case folding stays win32-scoped", () => {
  // A folding rule that leaked onto POSIX, where a filesystem may be case-sensitive, shows here.

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
});

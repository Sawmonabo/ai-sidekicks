// trust-envelope.test.ts — adversarial containment pins for the bind-time
// trust-envelope validator (Plan-009 Phase 1 T1.6).
//
// Spec coverage:
//   * `Spec-009 §Required Behavior` — "The system must reject path traversal or
//     workspace binding outside the declared local trust envelope."
//     → §traversal and escape, §envelope admission.
//   * `Spec-009 §Local Trust Envelope (V1 Definition)` — containment is
//     symlink-resolved, "path-component-boundary-aware (`/repo-evil` is not
//     within `/repo`)", and "case-folded on case-insensitive filesystems
//     (Windows tier per ADR-019)".
//     → §accepted roots, §traversal and escape, §win32 comparison.
//   * `Spec-009 §Local Trust Envelope (V1 Definition)` — `WorkspaceBind`'s
//     `directory` is "resolved against the mount's canonical root and
//     containment is re-checked AFTER symlink resolution"; "`..` traversal,
//     absolute-path redirection, and symlink escape outside the mount root" are
//     rejected with the typed error.
//     → §traversal and escape, §resolution order, §typed refusal.
//
// Invariant covered (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-3 — trust-envelope containment. No input — traversal, symlink
//     escape, prefix collision, absolute redirection, a foreign anchor, or an
//     unresolvable path — yields a validated root outside the canonical root of
//     a mount attached to the same session.
//     → every section below.
//
// Fixture strategy. Real temp directories and real symlinks for everything a
// POSIX filesystem can express, so the ordering guarantee is asserted against
// the kernel's own symlink resolution rather than an imitation of it. The two
// injected seams (`realpath`, `platformPath`) cover what this host cannot
// produce: win32 path shapes and case-folded comparison.
//
// Case sensitivity is NEVER read off the host. A macOS developer runs on
// case-insensitive APFS while CI runs on case-sensitive ext4, so a test that
// created `Repo` and looked for `repo` would pass on one and fail on the other.
// Every case-folding assertion below therefore runs through the `platformPath`
// seam against a synthetic filesystem, where the answer is a property of the
// injected platform and nothing else.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix as posixPath, sep, win32 as win32Path } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TrustEnvelopeViolationError } from "../repo-errors.js";
import {
  TrustEnvelopeValidator,
  type PathRealpathResolver,
  type WorkspaceExecutionRootCandidate,
} from "../trust-envelope.js";

// ----------------------------------------------------------------------------
// Real-filesystem fixtures
// ----------------------------------------------------------------------------

/**
 * One temp tree holding a mount, the things a bind may legitimately reach
 * inside it, and every shape that tries to leave it.
 *
 * The mount is named `repo` and its prefix-colliding sibling `repo-evil`, the
 * spec's own example.
 */
interface Fixtures {
  readonly fixtureRoot: string;
  readonly mountRoot: string;
  readonly nestedDirectory: string;
  readonly realSubdirectory: string;
  readonly symlinkInsideMount: string;
  readonly symlinkEscapingMount: string;
  readonly outsideDirectory: string;
  readonly outsideChild: string;
  readonly siblingDirectory: string;
  readonly prefixCollisionRoot: string;
  readonly prefixCollisionChild: string;
  readonly secondMountRoot: string;
  readonly secondMountChild: string;
  readonly aliasToMountRoot: string;
  readonly regularFileInMount: string;
}

let fixtures: Fixtures;

beforeAll(async () => {
  // The temp root is realpath'd once here, so every expectation below compares
  // against physical paths. On macOS `/var` is a symlink to `/private/var`, and
  // an un-resolved fixture root would make the validator's own (correct)
  // resolution look like a mismatch.
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

  // The two symlinks the invariant turns on: one that stays inside the mount
  // (must be accepted, and returned resolved) and one that leaves it (must be
  // refused even though its spelling never leaves).
  const symlinkInsideMount = join(mountRoot, "link-inside");
  const symlinkEscapingMount = join(mountRoot, "link-outside");
  await symlink(realSubdirectory, symlinkInsideMount);
  await symlink(outsideDirectory, symlinkEscapingMount);

  // An alias for the mount root itself — the shape a caller produces by
  // handing over a root that was never `realpath`-ed, and the shape an attacker
  // produces by replacing an admitted root with a link.
  const aliasToMountRoot = join(fixtureRoot, "alias-to-repo");
  await symlink(mountRoot, aliasToMountRoot);

  fixtures = {
    fixtureRoot,
    mountRoot,
    nestedDirectory,
    realSubdirectory,
    symlinkInsideMount,
    symlinkEscapingMount,
    outsideDirectory,
    outsideChild,
    siblingDirectory,
    prefixCollisionRoot,
    prefixCollisionChild,
    secondMountRoot,
    secondMountChild,
    aliasToMountRoot,
    regularFileInMount,
  };
});

afterAll(async () => {
  if (fixtures !== undefined) {
    await rm(fixtures.fixtureRoot, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** A bind against the fixture mount, with that mount as the whole envelope. */
function candidateInMount(directory?: string): WorkspaceExecutionRootCandidate {
  return {
    mountCanonicalRoot: fixtures.mountRoot,
    directory,
    sessionEnvelopeRoots: [fixtures.mountRoot],
  };
}

/**
 * Asserts the rejection is the typed carrier. Every refusal in this file goes
 * through here, so the "thrown errors are `TrustEnvelopeViolationError`" clause
 * of the T1.6 test contract is pinned on each case rather than once.
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
 * A `realpath` over a synthetic filesystem: spelled path → physical path.
 * Anything unmapped rejects like a missing path would, which is how the win32
 * cases express "this candidate does not exist".
 *
 * `recorded`, when supplied, collects every spelling it was asked for — that
 * is how the win32 cases assert a refusal happened BEFORE the filesystem.
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

// ----------------------------------------------------------------------------
// Envelope admission — I-009-3's "attached to the same session" clause
// ----------------------------------------------------------------------------

describe("envelope admission (I-009-3)", () => {
  // The anchor a bind names must BE one of the session's attached canonical
  // roots. `Spec-009 §Local Trust Envelope (V1 Definition)` defines the
  // envelope as "the set of fully resolved canonical roots of its attached repo
  // mounts", so membership is equality — which is what turns "attached to the
  // same session" from an assertion the caller makes into something the
  // validator checks.

  it("accepts an anchor that is one of several attached mounts", async () => {
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot({
      mountCanonicalRoot: fixtures.mountRoot,
      directory: "nested",
      sessionEnvelopeRoots: [fixtures.secondMountRoot, fixtures.mountRoot],
    });
    expect(validated).toBe(join(fixtures.mountRoot, "nested"));
  });

  it("refuses an anchor the session envelope does not contain", async () => {
    // The cross-session bind: a real, resolvable mount root that belongs to
    // someone else's envelope. Containment within it would succeed, so only
    // admission can refuse this.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        sessionEnvelopeRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses an anchor that only prefix-collides with an attached root", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.prefixCollisionRoot,
        directory: "inside",
        sessionEnvelopeRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses an anchor nested INSIDE an attached root — membership is equality", async () => {
    // A subdirectory of an attached mount is inside the envelope, but it is not
    // a mount canonical root, so it cannot serve as the bind anchor. Admitting
    // it would let a caller narrow the anchor to any directory it liked and
    // then bind relative to that.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.realSubdirectory,
        sessionEnvelopeRoots: [fixtures.mountRoot],
      }),
    );
  });

  it("refuses every candidate when the session has an empty envelope", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        sessionEnvelopeRoots: [],
      }),
    );
  });

  it("refuses a foreign anchor without touching the filesystem", async () => {
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({ realpath: recordingRealpath(recorded) }).validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        sessionEnvelopeRoots: [fixtures.mountRoot],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a relative anchor before it can be completed from the daemon's cwd", async () => {
    // `realpath` would resolve `repo` against the daemon's working directory
    // and hand back a real, plausible root with no relation to any mount.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator({ realpath: recordingRealpath(recorded) }).validateExecutionRoot({
        mountCanonicalRoot: "repo",
        directory: "nested",
        sessionEnvelopeRoots: ["repo"],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a relative envelope entry as an admission proof", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        sessionEnvelopeRoots: ["repo"],
      }),
    );
  });
});

// ----------------------------------------------------------------------------
// Accepted roots — Spec-009 §Local Trust Envelope (V1 Definition)
// ----------------------------------------------------------------------------

describe("accepted execution roots (I-009-3)", () => {
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
    // The acceptance path proves resolution actually ran: a validator that
    // skipped `realpath` would return the alias spelling, which is contained
    // too and would otherwise pass every other assertion in this file.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount("link-inside"),
    );
    expect(validated).toBe(fixtures.realSubdirectory);
    expect(validated).not.toBe(fixtures.symlinkInsideMount);
  });

  it("accepts a regular file inside the mount — containment is not a type check", async () => {
    // Deliberately in scope for the boundary and out of scope for this module:
    // the validator answers "is this inside the envelope", not "is this a usable
    // execution root". Whether an execution root must be a directory is T2.4's
    // bind contract and Plan-010's provisioning concern, and answering it here
    // would put a filesystem-type policy inside the security check.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount("README.md"),
    );
    expect(validated).toBe(fixtures.regularFileInMount);
  });

  it("accepts an absolute directory that stays inside the mount root", async () => {
    // `Spec-009 §Local Trust Envelope (V1 Definition)` rejects absolute-path
    // REDIRECTION outside the mount root, not the absolute spelling itself; the
    // boundary is containment, not how the caller wrote the path.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount(fixtures.realSubdirectory),
    );
    expect(validated).toBe(fixtures.realSubdirectory);
  });

  it("accepts `..` that stays inside the mount", async () => {
    // Spelled literally rather than through `join`, which would collapse the
    // `..` before the filesystem ever saw it — the very step this file pins to
    // the kernel.
    const validated = await new TrustEnvelopeValidator().validateExecutionRoot(
      candidateInMount("nested/deep/.."),
    );
    expect(validated).toBe(join(fixtures.mountRoot, "nested"));
  });
});

// ----------------------------------------------------------------------------
// Traversal, symlink escape, prefix collision, absolute redirection
// ----------------------------------------------------------------------------

describe("escapes from the mount root are refused (I-009-3)", () => {
  it("has real escape targets, so the refusals below are about containment", async () => {
    // Without this, a refusal could just as well mean the target did not exist —
    // the fail-closed arm — and the whole section would pass against a validator
    // that never checked a boundary at all.
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
    // The headline case: the spelling never leaves the mount, so only a check
    // performed AFTER symlink resolution can catch it.
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
    // `path.resolve(mountRoot, "link-outside/..")` collapses to the mount root
    // and would be accepted; the kernel resolves the same string to the parent
    // of the link's TARGET, which is outside. The validator must agree with the
    // kernel, since that is what a later `open()` will do.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-outside/..")),
    );
  });

  it("refuses a prefix-colliding sibling reached by traversal", async () => {
    // `/repo-evil` is not within `/repo` — the boundary is a path component,
    // not a string prefix.
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

  it("refuses an escape into ANOTHER mount attached to the same session", async () => {
    // The mount-scoped reading of `Spec-009 §Local Trust Envelope (V1
    // Definition)`, pinned: `WorkspaceBind` is mount-first (D-009-4) and the
    // spec rejects escape "outside the MOUNT root". The result here is inside
    // the session envelope, and it is still refused.
    const envelope = [fixtures.mountRoot, fixtures.secondMountRoot];
    const validator = new TrustEnvelopeValidator();

    // The positive control first: the same target, anchored on its OWN mount,
    // is accepted. So the refusal below is about which mount the bind named,
    // not about the target being unreachable.
    expect(
      await validator.validateExecutionRoot({
        mountCanonicalRoot: fixtures.secondMountRoot,
        directory: "sub",
        sessionEnvelopeRoots: envelope,
      }),
    ).toBe(fixtures.secondMountChild);

    await expectEnvelopeRefusal(
      validator.validateExecutionRoot({
        mountCanonicalRoot: fixtures.mountRoot,
        directory: join("..", "other-mount", "sub"),
        sessionEnvelopeRoots: envelope,
      }),
    );
  });

  it("refuses an anchor handed over as an alias rather than its canonical root", async () => {
    // The validator never re-resolves the anchor: doing so would make an
    // admitted root that was later replaced by a symlink agree with its new
    // target. The cost is that a caller who supplies an un-canonicalized root
    // is refused — the safe direction, and the one T1.5's postcondition makes
    // unreachable in production.
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.aliasToMountRoot,
        directory: "nested",
        sessionEnvelopeRoots: [fixtures.aliasToMountRoot],
      }),
    );
  });

  it("refuses an aliased anchor even with no directory at all", async () => {
    await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot({
        mountCanonicalRoot: fixtures.aliasToMountRoot,
        sessionEnvelopeRoots: [fixtures.aliasToMountRoot],
      }),
    );
  });

  it("refuses a candidate the filesystem will not resolve", async () => {
    // Fail-closed: containment cannot be PROVEN for a path that does not
    // resolve. The residual — a vanished mount root reporting as an envelope
    // violation rather than as `stale` — is documented on the module, and T2.4
    // probes reachability (T2.5 health) before binding.
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
    // The T1.6 acceptance criterion as one statement over the whole set.
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

// ----------------------------------------------------------------------------
// Resolution order — resolve, THEN contain
// ----------------------------------------------------------------------------

describe("the filesystem resolves before the boundary check runs", () => {
  it("hands the filesystem the spelled candidate, not a lexically collapsed one", async () => {
    // `path.resolve` would apply `..` before the filesystem saw the path,
    // silently renaming the target. The validator joins raw so the kernel
    // applies `..` to the link's resolved target.
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

// ----------------------------------------------------------------------------
// The refusal carrier — T1.4 typed, path-redacted contract
// ----------------------------------------------------------------------------

describe("refusals carry the typed, path-free error (T1.4)", () => {
  it("throws the registry-canonical code and notional status", async () => {
    const violation = await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("../sibling")),
    );
    expect(violation.code).toBe("repo.outside_trust_envelope");
    expect(violation.httpStatus).toBe(403);
    expect(violation.name).toBe("TrustEnvelopeViolationError");
  });

  it("leaks no path into the message or the wire detail", async () => {
    // `error-contracts.md §Repo` bars this code from echoing the attempted
    // path; T1.4 extends the ban to `fields`. The carrier takes no arguments,
    // so the guarantee is structural — this asserts the validator did not find
    // some other way to attach one.
    const violation = await expectEnvelopeRefusal(
      new TrustEnvelopeValidator().validateExecutionRoot(candidateInMount("link-outside")),
    );
    expect(violation.message).not.toContain(fixtures.fixtureRoot);
    expect(violation.message).not.toContain("link-outside");
    expect(violation.detail).toBeUndefined();
    // The positive control keeps the negative one honest: prove the spread
    // carries the own properties before asserting what it does not carry, so a
    // refactor that moved them onto the prototype cannot make this vacuous.
    expect(JSON.stringify({ ...violation })).toContain("repo.outside_trust_envelope");
    expect(JSON.stringify({ ...violation })).not.toContain(fixtures.fixtureRoot);
  });
});

// ----------------------------------------------------------------------------
// win32 comparison semantics, driven from POSIX CI (ADR-019 V1 tier)
// ----------------------------------------------------------------------------

describe("win32 case folding and root shapes (Spec-009 §Local Trust Envelope (V1 Definition))", () => {
  // Injecting `path.win32` is what makes the Windows branch observable on an
  // ubuntu runner. Every physical path here comes from the synthetic
  // filesystem, so nothing depends on the host's own case sensitivity.

  const WINDOWS_MOUNT_ROOT = "C:\\repos\\app";

  function windowsValidator(
    physicalPathBySpelling: Record<string, string>,
    recorded?: string[],
  ): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: win32Path,
      realpath: syntheticRealpath(physicalPathBySpelling, recorded),
    });
  }

  it("accepts a candidate whose physical spelling differs only in case", async () => {
    const validated = await windowsValidator({
      "C:\\repos\\app\\Src": "C:\\Repos\\App\\Src",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      directory: "Src",
      sessionEnvelopeRoots: [WINDOWS_MOUNT_ROOT],
    });
    // Folding governs the COMPARISON only; the returned root keeps the
    // filesystem's own spelling, since that is what gets executed against.
    expect(validated).toBe("C:\\Repos\\App\\Src");
  });

  it("admits an anchor whose envelope entry differs only in case", async () => {
    const validated = await windowsValidator({
      "C:\\repos\\app": "C:\\repos\\app",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      sessionEnvelopeRoots: ["C:\\REPOS\\APP"],
    });
    expect(validated).toBe(WINDOWS_MOUNT_ROOT);
  });

  it("refuses a case-folded prefix collision", async () => {
    // Folding must not soften the component boundary: `C:\repos\app-evil` is
    // still not within `C:\repos\app`.
    await expectEnvelopeRefusal(
      windowsValidator({
        "C:\\repos\\app\\out": "C:\\Repos\\App-Evil\\out",
      }).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "out",
        sessionEnvelopeRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
  });

  it("refuses a driveless absolute directory before the filesystem sees it", async () => {
    // `\evil` is absolute to `path.win32` while naming no volume, so only the
    // daemon's CURRENT DRIVE could complete it. Containment would still hold
    // the boundary, but the verdict on one identical request would depend on
    // ambient host state — so the join refuses the shape outright, and the
    // recorder proves it happened before any resolution.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      windowsValidator({ "\\evil": "C:\\evil" }, recorded).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "\\evil",
        sessionEnvelopeRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses the forward-slash spelling even when the drive completes it INSIDE", async () => {
    // The synthetic filesystem models a daemon whose current drive happens to
    // put `/evil` inside the mount. Containment would accept that, and the
    // same request on a daemon sitting on another drive would be refused —
    // the ambient-state dependence the gate removes. It is refused either way.
    await expectEnvelopeRefusal(
      windowsValidator({ "/evil": "C:\\repos\\app\\evil" }).validateExecutionRoot({
        mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
        directory: "/evil",
        sessionEnvelopeRoots: [WINDOWS_MOUNT_ROOT],
      }),
    );
  });

  it("still admits a drive-complete absolute directory inside the mount", async () => {
    // The gate refuses the INCOMPLETE shape only; a complete absolute path
    // that stays inside the mount keeps its acceptance.
    const validated = await windowsValidator({
      "C:\\repos\\app\\pkg": "C:\\repos\\app\\pkg",
    }).validateExecutionRoot({
      mountCanonicalRoot: WINDOWS_MOUNT_ROOT,
      directory: "C:\\repos\\app\\pkg",
      sessionEnvelopeRoots: [WINDOWS_MOUNT_ROOT],
    });
    expect(validated).toBe("C:\\repos\\app\\pkg");
  });

  it("refuses a drive-RELATIVE envelope entry as an admission proof", async () => {
    // `C:` is not absolute to `path.win32`, and the envelope-entry guard is
    // the only thing that separates it from `C:\` — both reduce to the single
    // component `c:`, so without the guard a drive-relative entry would admit
    // a drive-root anchor.
    await expectEnvelopeRefusal(
      windowsValidator({ "C:\\": "C:\\" }).validateExecutionRoot({
        mountCanonicalRoot: "C:\\",
        sessionEnvelopeRoots: ["C:"],
      }),
    );
  });

  it("refuses a drive-RELATIVE anchor before the filesystem sees it", async () => {
    // The mirror image, caught by the step-1 anchor guard: the components of
    // `C:` and `C:\` match, so without it admission would pass and the join
    // would proceed drive-relative.
    const recorded: string[] = [];
    await expectEnvelopeRefusal(
      windowsValidator({ "C:": "C:\\somewhere" }, recorded).validateExecutionRoot({
        mountCanonicalRoot: "C:",
        sessionEnvelopeRoots: ["C:\\"],
      }),
    );
    expect(recorded).toEqual([]);
  });

  it("refuses a resolved root that is drive-relative under a drive-root anchor", async () => {
    // Containment alone cannot carry absoluteness for a bare-root anchor:
    // `C:\` and a degenerate resolved `C:` both reduce to `["c:"]`. A real
    // `realpath` never returns that, so this pins the seam-consistent
    // absoluteness backstop rather than a reachable production path.
    await expectEnvelopeRefusal(
      windowsValidator({ "C:\\": "C:" }).validateExecutionRoot({
        mountCanonicalRoot: "C:\\",
        sessionEnvelopeRoots: ["C:\\"],
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
      sessionEnvelopeRoots: [uncRoot],
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
        sessionEnvelopeRoots: ["\\\\server\\share\\repo"],
      }),
    );
  });

  it("joins a drive-root anchor without doubling the separator", async () => {
    const validated = await windowsValidator({
      "C:\\data": "C:\\data",
    }).validateExecutionRoot({
      mountCanonicalRoot: "C:\\",
      directory: "data",
      sessionEnvelopeRoots: ["C:\\"],
    });
    expect(validated).toBe("C:\\data");
  });
});

describe("case folding stays win32-scoped (Spec-009 §Local Trust Envelope (V1 Definition))", () => {
  // The POSIX control. Same shapes as the win32 block, same synthetic
  // filesystem — only the injected platform differs, so a folding rule that
  // leaked onto POSIX would show up here and nowhere else.

  const POSIX_MOUNT_ROOT = "/repos/app";

  function posixValidator(physicalPathBySpelling: Record<string, string>): TrustEnvelopeValidator {
    return new TrustEnvelopeValidator({
      platformPath: posixPath,
      realpath: syntheticRealpath(physicalPathBySpelling),
    });
  }

  it("refuses a candidate whose physical spelling differs only in case", async () => {
    await expectEnvelopeRefusal(
      posixValidator({ "/repos/app/Src": "/Repos/App/Src" }).validateExecutionRoot({
        mountCanonicalRoot: POSIX_MOUNT_ROOT,
        directory: "Src",
        sessionEnvelopeRoots: [POSIX_MOUNT_ROOT],
      }),
    );
  });

  it("refuses an envelope entry that differs only in case", async () => {
    await expectEnvelopeRefusal(
      posixValidator({ "/repos/app": "/repos/app" }).validateExecutionRoot({
        mountCanonicalRoot: POSIX_MOUNT_ROOT,
        sessionEnvelopeRoots: ["/REPOS/APP"],
      }),
    );
  });

  it("joins a filesystem-root anchor without doubling the separator", async () => {
    // `//x` is implementation-defined under POSIX, so the join must not
    // produce it for a root that already ends in a separator.
    const validated = await posixValidator({ "/srv": "/srv" }).validateExecutionRoot({
      mountCanonicalRoot: "/",
      directory: "srv",
      sessionEnvelopeRoots: ["/"],
    });
    expect(validated).toBe("/srv");
  });
});

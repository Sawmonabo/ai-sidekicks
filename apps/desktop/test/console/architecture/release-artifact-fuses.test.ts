// The release artifact's fuse wire, read out of the artifact rather than out of the
// build script that claims to have flipped it.
//
// `Spec-023 §Security Hardening Baseline` names nine fuses and the state each must
// carry in a packaged build, and `Spec-023 §Console Test Tiers` puts the check beside
// the end-to-end tier as a SEPARATE one: the end-to-end tier drives the smoke build,
// where `EnableNodeCliInspectArguments` is deliberately left on so a harness can
// attach, so the artifact that tier launches is the one artifact whose fuse wire is
// expected to differ from the release posture. Reading the release artifact is a
// different question and needs a different subject.
//
// WHY IT READS THE BINARY AND NOT THE CONFIGURATION. A fuse is a byte in a sentinel
// region of the shipped Electron binary. A packaging config that names the right nine
// states proves that someone wrote them down; only the binary proves they landed —
// and the ordering `I-023-3` fixes (flip → digest → sign) is exactly the kind of
// pipeline where a step can be skipped, reordered, or silently no-op on one platform
// while the config stays green. `@electron/fuses`' own `getCurrentFuseWire` is the
// reader, so this file parses no sentinel itself.
//
// WHAT HAPPENS TODAY, STATED RATHER THAN SKIPPED QUIETLY. No packaging step exists in
// this repository yet — `electron-builder` is pinned and unwired — so there is no
// packaged artifact to read, and the fuse-wire case is skipped. The skip is narrow:
// the case below it runs on every machine and asserts that the artifact is absent for
// THAT reason and no other, so a `dist/` tree that exists in an unrecognized shape,
// or a packaged root holding no binary, is a failure rather than another skip. A skip
// nobody can distinguish from a pass is how a check like this rots.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getCurrentFuseWire, FuseState, FuseV1Options } from "@electron/fuses";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/** Where `electron-builder` writes its output for this package. */
const PACKAGED_OUTPUT_DIRECTORY = join(PACKAGE_ROOT, "dist");

/**
 * The per-platform roots `electron-builder` writes an unpacked application into, each
 * paired with the path from that root to the Electron binary the fuse wire lives in.
 *
 * Named rather than globbed, and that is the point: the set of directory names a
 * packaging step may produce is small and known, so a `dist/` tree that matches none
 * of them is an unrecognized layout — a claim this file can make and a glob cannot.
 * The macOS entry stops at the bundle because the executable inside it is named for
 * the product rather than for the platform, and is resolved by reading the directory.
 */
const PACKAGED_ROOTS: readonly { readonly directory: string; readonly kind: string }[] = [
  { directory: "mac", kind: "macOS application bundle" },
  { directory: "mac-arm64", kind: "macOS application bundle" },
  { directory: "mac-universal", kind: "macOS application bundle" },
  { directory: "win-unpacked", kind: "Windows unpacked directory" },
  { directory: "linux-unpacked", kind: "Linux unpacked directory" },
];

/**
 * The nine fuses and the state a release build must carry, from the corpus.
 *
 * `WasmTrapHandlers` is the one entry whose required state is also Electron's default;
 * it is listed anyway, because a posture that omits the fuses it agrees with is a
 * posture that cannot notice a default changing under it.
 */
const REQUIRED_RELEASE_FUSE_POSTURE: ReadonlyMap<FuseV1Options, FuseState> = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.ENABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);

/** The one reason a missing artifact is admissible, stated once and asserted below. */
const NO_PACKAGING_STEP_REASON =
  "no packaging step has produced an unpacked application: `electron-builder` is " +
  "pinned and not yet wired, so `dist/` holds no packaged root";

/** What a discovery pass found, or the reason it found nothing. */
type ArtifactDiscovery =
  | { readonly kind: "found"; readonly binaryPath: string; readonly rootKind: string }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The single file directly inside a macOS bundle's `Contents/MacOS`, if there is one. */
function resolveApplicationBundleBinary(bundlePath: string): string | null {
  const executableDirectory = join(bundlePath, "Contents", "MacOS");
  if (!existsSync(executableDirectory)) {
    return null;
  }
  const entries = readdirSync(executableDirectory).filter(
    (entry) => !entry.startsWith(".") && statSync(join(executableDirectory, entry)).isFile(),
  );
  return entries.length === 1 ? join(executableDirectory, entries[0] ?? "") : null;
}

/** The unpacked application's executable inside a Windows or Linux root, if there is one. */
function resolveUnpackedBinary(rootPath: string): string | null {
  const entries = readdirSync(rootPath).filter((entry) => {
    if (entry.startsWith(".") || !statSync(join(rootPath, entry)).isFile()) {
      return false;
    }
    // Windows names the executable `<product>.exe`; Linux names it `<product>` with no
    // extension. Every sibling an unpacked root carries — the ICU data, the snapshot,
    // the shared libraries, the licences — has one.
    return entry.endsWith(".exe") || !entry.includes(".");
  });
  return entries.length === 1 ? join(rootPath, entries[0] ?? "") : null;
}

/**
 * The packaged Electron binary under `outputDirectory`, or why there is none.
 *
 * Deliberately three outcomes and not two: "no packaged root exists" is the state this
 * repository is in and is admissible, while "a packaged root exists and no binary was
 * found inside it" is a packaging step that produced something this check cannot read,
 * which is a failure and must not wear the same skip.
 */
export function discoverPackagedElectronBinary(outputDirectory: string): ArtifactDiscovery {
  if (!existsSync(outputDirectory)) {
    return { kind: "absent", reason: NO_PACKAGING_STEP_REASON };
  }
  const presentRoots = PACKAGED_ROOTS.filter((root) =>
    existsSync(join(outputDirectory, root.directory)),
  );
  if (presentRoots.length === 0) {
    return { kind: "absent", reason: NO_PACKAGING_STEP_REASON };
  }
  for (const root of presentRoots) {
    const rootPath = join(outputDirectory, root.directory);
    const bundleName = readdirSync(rootPath).find((entry) => entry.endsWith(".app"));
    const binaryPath =
      bundleName === undefined
        ? resolveUnpackedBinary(rootPath)
        : resolveApplicationBundleBinary(join(rootPath, bundleName));
    if (binaryPath !== null) {
      return { kind: "found", binaryPath, rootKind: root.kind };
    }
  }
  return {
    kind: "unreadable",
    reason:
      `a packaged root exists (${presentRoots.map((root) => root.directory).join(", ")}) ` +
      "and holds no single application binary this check can read",
  };
}

/** Every fuse whose state in `wire` is not the state the release posture requires. */
export function findFusePostureViolations(
  wire: Partial<Record<FuseV1Options, FuseState>>,
  requiredPosture: ReadonlyMap<FuseV1Options, FuseState>,
): readonly string[] {
  const violations: string[] = [];
  for (const [fuse, requiredState] of requiredPosture) {
    const actualState = wire[fuse];
    if (actualState !== requiredState) {
      violations.push(
        `${FuseV1Options[fuse] ?? String(fuse)}: required ${FuseState[requiredState] ?? "?"}, ` +
          `artifact carries ${actualState === undefined ? "nothing" : (FuseState[actualState] ?? "?")}`,
      );
    }
  }
  return violations;
}

const discovery = discoverPackagedElectronBinary(PACKAGED_OUTPUT_DIRECTORY);

describe("the release artifact carries the declared fuse wire", () => {
  it("finds a packaged artifact, or is absent for the one admissible reason", () => {
    // The guard on the skip below. An unreadable packaged root fails here rather than
    // skipping, so the skip can only ever mean the one thing it says.
    expect(
      discovery.kind,
      `packaged artifact discovery under ${PACKAGED_OUTPUT_DIRECTORY}`,
    ).not.toBe("unreadable");
    if (discovery.kind === "absent") {
      expect(discovery.reason).toBe(NO_PACKAGING_STEP_REASON);
    }
  });

  it.skipIf(discovery.kind !== "found")(
    "flips every fuse the hardening baseline names",
    async () => {
      if (discovery.kind !== "found") {
        return;
      }
      const wire = await getCurrentFuseWire(discovery.binaryPath);
      expect(
        findFusePostureViolations(wire, REQUIRED_RELEASE_FUSE_POSTURE),
        `${discovery.rootKind} at ${discovery.binaryPath}: the packaging pipeline flips ` +
          "the wire before the digest and the signature, so a violation here is a " +
          "release that ships with hardening the corpus says it has",
      ).toStrictEqual([]);
    },
  );
});

// Negative controls. The check above skips on every machine today, so every helper it
// would use is exercised here on synthetic input — including the two shapes that must
// NOT be read as an absent artifact.
describe("the artifact reader and the posture comparison can fail", () => {
  const REQUIRED_POSTURE_FIXTURE: ReadonlyMap<FuseV1Options, FuseState> = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  ]);

  it("reports a clean wire as clean", () => {
    expect(
      findFusePostureViolations(
        {
          [FuseV1Options.RunAsNode]: FuseState.DISABLE,
          [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
        },
        REQUIRED_POSTURE_FIXTURE,
      ),
    ).toStrictEqual([]);
  });

  it("names a fuse left in the wrong state", () => {
    expect(
      findFusePostureViolations(
        {
          [FuseV1Options.RunAsNode]: FuseState.ENABLE,
          [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
        },
        REQUIRED_POSTURE_FIXTURE,
      ),
    ).toStrictEqual(["RunAsNode: required DISABLE, artifact carries ENABLE"]);
  });

  it("names a fuse the wire does not carry at all", () => {
    expect(
      findFusePostureViolations(
        { [FuseV1Options.RunAsNode]: FuseState.DISABLE },
        REQUIRED_POSTURE_FIXTURE,
      ),
    ).toStrictEqual(["OnlyLoadAppFromAsar: required ENABLE, artifact carries nothing"]);
  });

  it("refuses an inherited state, which is neither of the two the posture admits", () => {
    expect(
      findFusePostureViolations(
        {
          [FuseV1Options.RunAsNode]: FuseState.INHERIT,
          [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.REMOVED,
        },
        REQUIRED_POSTURE_FIXTURE,
      ),
    ).toHaveLength(2);
  });

  it("requires every fuse the hardening baseline names", () => {
    // The posture is a claim about a closed list; a member dropped from it would make
    // the check above quietly narrower with nothing to notice.
    expect(REQUIRED_RELEASE_FUSE_POSTURE.size).toBe(
      Object.values(FuseV1Options).filter((value) => typeof value === "number").length,
    );
  });
});

describe("the packaged-artifact discovery can fail", () => {
  const SYNTHETIC_ROOT = join(PACKAGE_ROOT, "test", "console", "architecture");
  const temporaryDirectories: string[] = [];

  function syntheticOutputDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "console-fuse-artifact-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("reads an absent output directory as the one admissible absence", () => {
    const absent = discoverPackagedElectronBinary(join(SYNTHETIC_ROOT, "no-such-dist"));
    expect(absent).toStrictEqual({ kind: "absent", reason: NO_PACKAGING_STEP_REASON });
  });

  it("reads a directory holding no packaged root as that same absence", () => {
    // A real directory, full of files, none of them a packaging output.
    expect(discoverPackagedElectronBinary(SYNTHETIC_ROOT)).toStrictEqual({
      kind: "absent",
      reason: NO_PACKAGING_STEP_REASON,
    });
  });

  it("finds the binary inside an unpacked root", () => {
    // Without this the two absences above are consistent with a reader that finds
    // nothing anywhere, and the whole check would be vacuous the day one is built.
    const outputDirectory = syntheticOutputDirectory();
    mkdirSync(join(outputDirectory, "linux-unpacked"));
    writeFileSync(join(outputDirectory, "linux-unpacked", "ai-sidekicks"), "");
    writeFileSync(join(outputDirectory, "linux-unpacked", "icudtl.dat"), "");
    expect(discoverPackagedElectronBinary(outputDirectory)).toStrictEqual({
      kind: "found",
      binaryPath: join(outputDirectory, "linux-unpacked", "ai-sidekicks"),
      rootKind: "Linux unpacked directory",
    });
  });

  it("finds the binary inside a macOS application bundle", () => {
    const outputDirectory = syntheticOutputDirectory();
    const executableDirectory = join(
      outputDirectory,
      "mac-arm64",
      "AI Sidekicks.app",
      "Contents",
      "MacOS",
    );
    mkdirSync(executableDirectory, { recursive: true });
    writeFileSync(join(executableDirectory, "AI Sidekicks"), "");
    expect(discoverPackagedElectronBinary(outputDirectory)).toStrictEqual({
      kind: "found",
      binaryPath: join(executableDirectory, "AI Sidekicks"),
      rootKind: "macOS application bundle",
    });
  });

  it("refuses a packaged root that holds no readable binary", () => {
    // The arm that must never wear the skip: a packaging step ran and produced
    // something this check cannot read.
    const outputDirectory = syntheticOutputDirectory();
    mkdirSync(join(outputDirectory, "win-unpacked"));
    writeFileSync(join(outputDirectory, "win-unpacked", "resources.pak"), "");
    const discovered = discoverPackagedElectronBinary(outputDirectory);
    expect(discovered.kind).toBe("unreadable");
    expect(discovered.kind === "unreadable" ? discovered.reason : "").toContain("win-unpacked");
  });
});

// Reads the release artifact's fuse wire out of the packaged binary, through `@electron/fuses`'
// own `getCurrentFuseWire`, because only the binary proves a flip landed: a packaging config that
// names the nine states proves only that someone wrote them down, and a packaging step can
// silently no-op on one platform.
//
// The end-to-end tier cannot answer this: it drives the smoke build, which leaves
// `EnableNodeCliInspectArguments` on so a harness can attach.
//
// With no packaged root in `dist/`, the fuse-wire case skips. The case before it fails on a `dist/`
// tree in a shape it does not recognize or a packaged root with no binary, so the skip means only
// that no artifact exists.

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
import { join } from "node:path";

import { getCurrentFuseWire, FuseState, FuseV1Options } from "@electron/fuses";
import { afterEach, describe, expect, it } from "vitest";

import { PACKAGE_ROOT } from "#test/helpers/fixture/bundle.js";

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
 * The nine fuses and the state a release build must carry.
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
  "no packaging step has produced an unpacked application, so `dist/` holds no packaged root";

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
    // the shared libraries, the licenses — has one.
    return entry.endsWith(".exe") || !entry.includes(".");
  });
  return entries.length === 1 ? join(rootPath, entries[0] ?? "") : null;
}

/**
 * The packaged Electron binary under `outputDirectory`, or why there is none.
 *
 * Three outcomes, not two: "no packaged root exists" is admissible, while "a packaged root exists
 * and holds no binary" is a packaging step that produced something this check cannot read, which
 * is a failure and must not wear the same skip.
 */
function discoverPackagedElectronBinary(outputDirectory: string): ArtifactDiscovery {
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
function findFusePostureViolations(
  wire: Partial<Record<FuseV1Options, FuseState>>,
  requiredPosture: ReadonlyMap<FuseV1Options, FuseState>,
): readonly string[] {
  const violations: string[] = [];
  for (const [fuse, requiredState] of requiredPosture) {
    const actualState = wire[fuse];
    if (actualState !== requiredState) {
      const carried = actualState === undefined ? "nothing" : (FuseState[actualState] ?? "?");
      violations.push(
        `${FuseV1Options[fuse] ?? String(fuse)}: required ${FuseState[requiredState] ?? "?"}, ` +
          `artifact carries ${carried}`,
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
        `${discovery.rootKind} at ${discovery.binaryPath}: a violation here is a release ` +
          "that ships without the hardening baseline it declares",
      ).toStrictEqual([]);
    },
  );
});

// Negative controls: with no packaged artifact the check above skips, so every helper it uses is
// driven here on synthetic input, including the two shapes that must not read as an absent one.
describe("the artifact reader and the posture comparison can fail", () => {
  const REQUIRED_POSTURE_FIXTURE: ReadonlyMap<FuseV1Options, FuseState> = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  ]);

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
});

describe("the packaged-artifact discovery can fail", () => {
  const temporaryDirectories: string[] = [];

  function syntheticOutputDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "sidekicks-fuse-artifact-"));
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

  it("finds the binary inside an unpacked root", () => {
    // Without this an absent reading is consistent with a reader that finds nothing
    // anywhere, and the whole check would be vacuous the day one is built.
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

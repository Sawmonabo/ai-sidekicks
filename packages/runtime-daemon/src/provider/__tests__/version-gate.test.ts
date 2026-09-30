// Spawn-time binary resolution, the in-band version read and the floor gate: the version recorded
// is the one the spawned build reported, a below-floor or unparseable build is refused before any
// other use, and every provider child carries its auto-update opt-out.

import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverCliVersionReport } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
} from "../__fixtures__/capability-probe-doubles.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../capability-refresh.js";
import type { DeclareDriverCapabilitiesResult } from "../driver-capabilities-writer.js";
import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import {
  withSpawnedVersionCarriers,
  type CreateRuntimeBindingInput,
} from "../runtime-binding-store.js";
import {
  DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
  ProviderExecutableUnresolvableError,
  composeProviderChildEnvironment,
  extractClaudeReportedVersion,
  extractCodexReportedVersion,
  readSpawnedProviderVersion,
  resolveProviderExecutable,
  toBindingVersionCarriers,
  type ProviderVersionHandshakeRequest,
  type SpawnedProviderVersionReading,
} from "../version-gate.js";
import { CODEX_DRIVER_NAME, refreshCodexCapabilities } from "../drivers/codex/capabilities.js";

/**
 * A handshake transport keyed by resolved path, so the fixture can answer differently for a
 * launcher's path and the build it dereferences to.
 */
class RecordingHandshake {
  readonly requests: ProviderVersionHandshakeRequest[] = [];
  readonly #repliesByPath: ReadonlyMap<string, unknown>;

  constructor(repliesByPath: Readonly<Record<string, unknown>>) {
    this.#repliesByPath = new Map(Object.entries(repliesByPath));
  }

  readonly run = (request: ProviderVersionHandshakeRequest): Promise<unknown> => {
    this.requests.push(request);
    const reply = this.#repliesByPath.get(request.resolvedExecutablePath);
    if (reply === undefined) {
      // An unregistered path is a test-design bug: fail loudly instead of reading as an
      // unparseable provider reply.
      return Promise.reject(
        new Error(`no handshake reply registered for ${request.resolvedExecutablePath}`),
      );
    }
    return Promise.resolve(reply);
  };
}

function codexUserAgent(codexVersion: string, clientVersion = "0.9.0"): string {
  // The shape measured at the pin: `<clientName>/<codexVersion> (<os>; <arch>)
  // <terminal> (<clientName>; <clientVersion>)`.
  return (
    `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}/${codexVersion} (macos; aarch64) ` +
    `iTerm.app (${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}; ${clientVersion})`
  );
}

describe("auto-update suppression in the spawned child", () => {
  it("applies the opt-out OVER the inherited environment, so it cannot be re-enabled", () => {
    const composed = composeProviderChildEnvironment("claude", {
      PATH: "/usr/bin",
      DISABLE_AUTOUPDATER: "0",
    });
    expect(composed["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(composed["DISABLE_UPDATES"]).toBe("1");
    // Everything else passes through untouched.
    expect(composed["PATH"]).toBe("/usr/bin");
  });

  it("carries the opt-out into the version handshake's own child", async () => {
    // The handshake spawn is a driver-spawned child too; a build that auto-updated during its
    // own version handshake would falsify that reading.
    const executable = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";
    const handshake = new RecordingHandshake({
      [executable]: { version: "2.1.245", buildTime: "2026-08-25T04:00:18Z" },
    });
    await readSpawnedProviderVersion({
      driverName: "claude",
      requestedCommand: executable,
      handshake: handshake.run,
      baseEnvironment: { DISABLE_AUTOUPDATER: "0" },
      resolver: {
        isExecutableFile: () => Promise.resolve(true),
        realpath: (candidate) => Promise.resolve(candidate),
        platform: "darwin",
      },
    });

    expect(handshake.requests).toHaveLength(1);
    expect(handshake.requests[0]?.environment["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(handshake.requests[0]?.environment["DISABLE_UPDATES"]).toBe("1");
  });
});

describe("provider executable resolution", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    temporaryDirectories.length = 0;
  });

  async function makeLauncherFixture(): Promise<{
    readonly launcherPath: string;
    readonly buildPath: string;
    readonly binDirectory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "ais-version-gate-"));
    temporaryDirectories.push(root);
    const binDirectory = join(root, "bin");
    const buildDirectory = join(root, "builds", "2.1.245");
    await mkdir(binDirectory, { recursive: true });
    await mkdir(buildDirectory, { recursive: true });
    const buildPath = join(buildDirectory, "claude");
    await writeFile(buildPath, "#!/bin/sh\nexit 0\n");
    await chmod(buildPath, 0o755);
    const launcherPath = join(binDirectory, "claude");
    await symlink(buildPath, launcherPath);
    return { launcherPath, buildPath, binDirectory };
  }

  // Symlink creation is unprivileged only on posix hosts; the win32 leg is covered by the
  // injected-seam cases below.
  describe.skipIf(process.platform === "win32")("against a real launcher symlink", () => {
    it("dereferences a launcher to the exact build path", async () => {
      const { launcherPath, buildPath } = await makeLauncherFixture();
      const resolved = await resolveProviderExecutable("claude", launcherPath);
      expect(resolved.requestedCommand).toBe(launcherPath);
      // `realpath` also resolves the temp root's own symlinks (macOS `/var` to `/private/var`),
      // so assert on the final components.
      expect(resolved.resolvedExecutablePath.endsWith(join("builds", "2.1.245", "claude"))).toBe(
        true,
      );
      expect(resolved.resolvedExecutablePath).not.toBe(launcherPath);
      expect(buildPath.endsWith(join("builds", "2.1.245", "claude"))).toBe(true);
    });

    it("finds a BARE command along PATH and then dereferences it", async () => {
      const { binDirectory } = await makeLauncherFixture();
      const resolved = await resolveProviderExecutable("claude", "claude", {
        readEnvironment: () => ({ PATH: binDirectory }),
      });
      expect(resolved.resolvedExecutablePath.endsWith(join("builds", "2.1.245", "claude"))).toBe(
        true,
      );
    });

    it("RECORDS THE SPAWNED BUILD'S VERSION WHEN THE LAUNCHER NAMES ANOTHER ONE", async () => {
      // Launcher drift: the transport answers `2.1.245` for the dereferenced build and `2.1.198`
      // for the launcher path; the reading and both binding carriers must carry the build's.
      const { launcherPath } = await makeLauncherFixture();
      const resolved = await resolveProviderExecutable("claude", launcherPath);
      const handshake = new RecordingHandshake({
        [resolved.resolvedExecutablePath]: { version: "2.1.245" },
        [launcherPath]: { version: "2.1.198" },
      });

      const reading = await readSpawnedProviderVersion({
        driverName: "claude",
        requestedCommand: launcherPath,
        handshake: handshake.run,
        baseEnvironment: {},
      });

      expect(reading.report).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
      expect(reading.resolvedExecutablePath).toBe(resolved.resolvedExecutablePath);
      expect(reading.resolvedExecutablePath).not.toBe(launcherPath);
      // The launcher was never spawned.
      expect(handshake.requests.map((request) => request.resolvedExecutablePath)).toStrictEqual([
        resolved.resolvedExecutablePath,
      ]);

      const carriers = toBindingVersionCarriers(reading);
      expect(carriers.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
      expect(carriers.resolvedExecutablePath).toBe(resolved.resolvedExecutablePath);
    });
  });

  it("refuses an unresolvable command as driver.unavailable", async () => {
    let thrown: unknown;
    try {
      await resolveProviderExecutable("codex", "codex", {
        readEnvironment: () => ({ PATH: "/nowhere/at/all" }),
        isExecutableFile: () => Promise.resolve(false),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderExecutableUnresolvableError);
    const refusal = thrown as ProviderExecutableUnresolvableError;
    expect(refusal.code).toBe("driver.unavailable");
    expect(refusal.fields.driverName).toBe("codex");
    expect(refusal.fields.requestedCommand).toBe("codex");
  });

  it("expands PATHEXT on win32, where the executable-bit probe is inert", async () => {
    // The win32 logic under test is the `PATHEXT` expansion and its ordering. Path syntax is
    // `node:path`'s and follows the host, so the fixture uses host-shaped PATH entries.
    const probed: string[] = [];
    const resolved = await resolveProviderExecutable("claude", "claude", {
      platform: "win32",
      readEnvironment: () => ({ PATH: join("/tools"), PATHEXT: ".COM;.EXE;.CMD" }),
      isExecutableFile: (candidate) => {
        probed.push(candidate);
        return Promise.resolve(candidate.endsWith(".CMD"));
      },
      realpath: (candidate) => Promise.resolve(candidate),
    });
    expect(resolved.resolvedExecutablePath.endsWith("claude.CMD")).toBe(true);
    expect(probed.some((candidate) => candidate.endsWith("claude.COM"))).toBe(true);
  });

  it("tries the bare name LAST for an extensionless win32 command", async () => {
    // The full candidate order is observable only when nothing matches (the resolver stops at
    // the first executable candidate); an extensionless file must never shadow the `.CMD` shim.
    const probed: string[] = [];
    await expect(
      resolveProviderExecutable("claude", "claude", {
        platform: "win32",
        readEnvironment: () => ({ PATH: join("/tools"), PATHEXT: ".COM;.EXE;.CMD" }),
        isExecutableFile: (candidate) => {
          probed.push(candidate);
          return Promise.resolve(false);
        },
        realpath: (candidate) => Promise.resolve(candidate),
      }),
    ).rejects.toBeInstanceOf(ProviderExecutableUnresolvableError);
    expect(probed.map((candidate) => candidate.split(/[/\\]/).pop())).toStrictEqual([
      "claude.COM",
      "claude.EXE",
      "claude.CMD",
      "claude",
    ]);
  });

  it("skips a candidate whose realpath fails rather than trusting the launcher path", async () => {
    // The candidate vanished between probe and dereference; falling back to the unresolved path
    // would record the launcher this module exists to distrust, so it is skipped.
    await expect(
      resolveProviderExecutable("claude", "/opt/bin/claude", {
        isExecutableFile: () => Promise.resolve(true),
        realpath: () => Promise.reject(new Error("ENOENT")),
      }),
    ).rejects.toBeInstanceOf(ProviderExecutableUnresolvableError);
  });
});

describe("in-band version read — Claude get_binary_version", () => {
  it("adopts the reply's version as-is", () => {
    expect(
      extractClaudeReportedVersion({ version: "2.1.234", buildTime: "2026-08-17T01:20:38Z" }),
    ).toBe("2.1.234");
  });

  it("refuses a reply carrying no version string as unparseable", () => {
    for (const payload of [undefined, null, "2.1.234", { buildTime: "x" }, { version: 2 }]) {
      expect(() => extractClaudeReportedVersion(payload)).toThrow(DriverCliVersionUnparseableError);
    }
  });
});

describe("in-band version read — Codex initialize userAgent", () => {
  it("extracts the PROVIDER's version from the composite string", () => {
    // The caller's own version (`0.9.0`) also appears in the string, and a trailing-parenthetical
    // parse would return it.
    const userAgent = codexUserAgent("0.149.1", "0.9.0");
    expect(extractCodexReportedVersion({ userAgent }, DEFAULT_PROVIDER_VERSION_CLIENT_NAME)).toBe(
      "0.149.1",
    );
  });

  it("refuses a userAgent whose leading token is not the name the daemon supplied", () => {
    // Shape drift or another client's string: guessing would report another process's version.
    const userAgent = `some-other-client/0.149.1 (macos; aarch64)`;
    expect(() =>
      extractCodexReportedVersion({ userAgent }, DEFAULT_PROVIDER_VERSION_CLIENT_NAME),
    ).toThrow(DriverCliVersionUnparseableError);
  });

  it("refuses a token that merely CONTAINS a semver rather than being one", () => {
    for (const token of ["v0.149.1", "0.149.1+meta", "0.149", "nightly-0.149.1-x"]) {
      expect(() =>
        extractCodexReportedVersion(
          { userAgent: `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}/${token} (macos; aarch64)` },
          DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
        ),
      ).toThrow(DriverCliVersionUnparseableError);
    }
  });

  it("refuses a reply carrying no userAgent as unparseable", () => {
    for (const payload of [undefined, null, {}, { userAgent: 7 }]) {
      expect(() =>
        extractCodexReportedVersion(payload, DEFAULT_PROVIDER_VERSION_CLIENT_NAME),
      ).toThrow(DriverCliVersionUnparseableError);
    }
  });
});

describe("the floor gate at the spawn", () => {
  const CODEX_EXECUTABLE = "/opt/homebrew/Cellar/codex/0.149.1/bin/codex";

  function passthroughResolver(): {
    readonly isExecutableFile: () => Promise<boolean>;
    readonly realpath: (candidate: string) => Promise<string>;
    readonly platform: NodeJS.Platform;
  } {
    return {
      isExecutableFile: () => Promise.resolve(true),
      realpath: (candidate) => Promise.resolve(candidate),
      platform: "darwin",
    };
  }

  async function attachCodex(
    sink: RecordingDeclarationSink,
    handshake: RecordingHandshake,
    probe: RecordingCapabilityProbeTransport = new RecordingCapabilityProbeTransport("codex"),
  ): Promise<DeclareDriverCapabilitiesResult> {
    const reading = await readSpawnedProviderVersion({
      driverName: CODEX_DRIVER_NAME,
      requestedCommand: CODEX_EXECUTABLE,
      handshake: handshake.run,
      baseEnvironment: {},
      resolver: passthroughResolver(),
    });
    return refreshCodexCapabilities(sink, {
      reading,
      probe: probe.exchange,
      diagnostics: new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } }),
    });
  }

  it("refuses a below-floor build AFTER the handshake spawn and BEFORE any other use", async () => {
    // The handshake process may spawn (the version is read in-band from it); the refusal precedes
    // every other use: no declaration reaches the writer and no second request reaches the process.
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: codexUserAgent("0.140.0") },
    });
    const sink = new RecordingDeclarationSink();
    const probe = new RecordingCapabilityProbeTransport("codex");

    let thrown: unknown;
    try {
      await attachCodex(sink, handshake, probe);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DriverCliVersionBelowFloorError);
    expect((thrown as DriverCliVersionBelowFloorError).fields).toStrictEqual({
      driverName: "codex",
      reportedSemver: "0.140.0",
      floor: DRIVER_CLI_VERSION_FLOORS.codex,
    });
    expect(handshake.requests).toHaveLength(1);
    expect(sink.calls).toHaveLength(0);
    // A refused build is never asked what it can do, so not even the probe channel's negative
    // control is issued against it.
    expect(probe.requests).toHaveLength(0);
  });

  it("admits a build exactly at the floor", async () => {
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: codexUserAgent(DRIVER_CLI_VERSION_FLOORS.codex) },
    });
    const sink = new RecordingDeclarationSink();
    await attachCodex(sink, handshake);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.result.cliVersion.semver).toBe(DRIVER_CLI_VERSION_FLOORS.codex);
  });

  it("ATTACHES an above-the-pin build — newer-than-measured is not a refusal", async () => {
    // The floor comparison is the whole gate: a build above the measured pin attaches.
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: codexUserAgent("9.99.0") },
    });
    const sink = new RecordingDeclarationSink();
    await attachCodex(sink, handshake);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.result.cliVersion).toStrictEqual({ raw: "9.99.0", semver: "9.99.0" });
  });

  it("refuses an unparseable in-band report before the floor is ever compared", async () => {
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: "codex-cli (unknown build)" },
    });
    const sink = new RecordingDeclarationSink();
    await expect(attachCodex(sink, handshake)).rejects.toBeInstanceOf(
      DriverCliVersionUnparseableError,
    );
    expect(sink.calls).toHaveLength(0);
  });

  it("spawns the RESOLVED path and names the daemon's client on the request", async () => {
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: codexUserAgent("0.149.1") },
    });
    await readSpawnedProviderVersion({
      driverName: CODEX_DRIVER_NAME,
      requestedCommand: CODEX_EXECUTABLE,
      handshake: handshake.run,
      baseEnvironment: {},
      resolver: passthroughResolver(),
    });
    const request = handshake.requests[0];
    expect(request?.resolvedExecutablePath).toBe(CODEX_EXECUTABLE);
    expect(request?.clientName).toBe(DEFAULT_PROVIDER_VERSION_CLIENT_NAME);
    expect(request?.driverName).toBe("codex");
  });
});

describe("the binding carriers come from one reading", () => {
  const READING: SpawnedProviderVersionReading = {
    driverName: "claude",
    resolvedExecutablePath: "/opt/homebrew/Cellar/claude/2.1.245/bin/claude",
    report: { raw: "2.1.245", semver: "2.1.245" },
  };

  const BASE_INPUT: Omit<CreateRuntimeBindingInput, "cliVersion"> = {
    runId: "run-1",
    driverName: "claude",
    contractVersion: "1.0.0",
    spawnConfig: {
      executionPosture: { mode: "trusted", networkAccess: "none", writableRoots: [] },
    },
  };

  it("fills both carriers from the reading and preserves the rest of spawn_config", () => {
    const input = withSpawnedVersionCarriers(BASE_INPUT, toBindingVersionCarriers(READING));
    expect(input.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
    expect(input.spawnConfig.resolvedExecutablePath).toBe(READING.resolvedExecutablePath);
    expect(input.spawnConfig.executionPosture).toStrictEqual(
      BASE_INPUT.spawnConfig.executionPosture,
    );
  });

  it("accepts a spawn_config that already names the SAME executable", () => {
    const input = withSpawnedVersionCarriers(
      { ...BASE_INPUT, spawnConfig: { resolvedExecutablePath: READING.resolvedExecutablePath } },
      toBindingVersionCarriers(READING),
    );
    expect(input.spawnConfig.resolvedExecutablePath).toBe(READING.resolvedExecutablePath);
  });

  it("REFUSES a spawn_config naming a different executable from the reading", () => {
    // A row must never record one install's version beside another install's path.
    expect(() =>
      withSpawnedVersionCarriers(
        { ...BASE_INPUT, spawnConfig: { resolvedExecutablePath: "/usr/local/bin/claude" } },
        toBindingVersionCarriers(READING),
      ),
    ).toThrow(/one reading/);
  });

  it("records a version the reading produced, never one a caller supplied", () => {
    // Type-level: `cliVersion` is omitted from the input, so a reading is the only way to reach
    // the column pair. Runtime: a stray member on an untyped caller's object is overwritten.
    const smuggled = {
      ...BASE_INPUT,
      cliVersion: { raw: "9.9.9", semver: "9.9.9" } satisfies DriverCliVersionReport,
    } as Omit<CreateRuntimeBindingInput, "cliVersion">;
    const input = withSpawnedVersionCarriers(smuggled, toBindingVersionCarriers(READING));
    expect(input.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
  });
});

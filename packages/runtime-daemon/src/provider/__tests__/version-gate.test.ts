/**
 * Plan-005 T3.23 — spawn-time binary resolution, the in-band version read, and
 * the ratified floor gate (I-005-10).
 *
 * Coverage targets, taken from the task's own Tests field and from
 * `Spec-005 §Required Behavior` (2026-08-26) rather than restated from the
 * module under test:
 *
 *   * A below-floor build refuses attach as `driver.cli_version_below_floor`
 *     BEFORE session creation, before any capability probe, and before any
 *     billed turn — while the minimal version-handshake process is still
 *     PERMITTED to spawn, because the version is read in-band from it. The
 *     assertion is therefore an ordering-and-absence one: the handshake ran
 *     exactly once, and nothing used that process afterwards.
 *   * An above-pin build attaches (newer-than-measured is the expected state,
 *     not an exception).
 *   * The LAUNCHER-DRIFT arm: the version the binding row records equals the
 *     version the SPAWNED process reported, asserted against a path-addressed
 *     spawn whose launcher names a different build. This is the case a
 *     `--version` shell-out gets wrong.
 *   * An unparseable in-band report still refuses as
 *     `driver.cli_version_unparseable` — on both channels, including the Codex
 *     composite `userAgent` whose naive parse returns the CALLER's version.
 *   * Every driver-spawned child carries its provider's auto-update opt-out.
 */

import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverCliVersionReport } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingCapabilityProbeTransport } from "../__fixtures__/capability-probe-doubles.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
  type FlooredDriverName,
} from "../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
} from "../driver-capabilities-writer.js";
import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import {
  withSpawnedVersionCarriers,
  type CreateRuntimeBindingInput,
} from "../runtime-binding-store.js";
import { PROVIDER_AUTO_UPDATE_OPT_OUT_ENV } from "../spawn-env.js";
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
import {
  CODEX_DRIVER_NAME,
  refreshCodexCapabilities,
  type DriverCapabilityDeclarationSink,
} from "../drivers/codex/capabilities.js";

// --------------------------------------------------------------------------
// Doubles
// --------------------------------------------------------------------------

/**
 * A handshake transport keyed BY RESOLVED PATH. That keying is the whole
 * launcher-drift experiment: the fixture can register one answer for the
 * launcher's path and a different one for the build it dereferences to, so a
 * module that read the launcher would produce a demonstrably different reading.
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
      // A spawn of a path the fixture never registered is a test-design bug,
      // not a provider behaviour — fail loudly rather than answering `undefined`
      // and letting it read as an unparseable provider reply.
      return Promise.reject(
        new Error(`no handshake reply registered for ${request.resolvedExecutablePath}`),
      );
    }
    return Promise.resolve(reply);
  };
}

class RecordingDeclarationSink implements DriverCapabilityDeclarationSink {
  readonly calls: DeclareDriverCapabilitiesInput[] = [];

  declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    this.calls.push(input);
    return Promise.resolve({ emitted: "declared", cliVersionRefreshed: true });
  }
}

function codexUserAgent(codexVersion: string, clientVersion = "0.9.0"): string {
  // The shape measured at the pin: `<clientName>/<codexVersion> (<os>; <arch>)
  // <terminal> (<clientName>; <clientVersion>)`.
  return (
    `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}/${codexVersion} (macos; aarch64) ` +
    `iTerm.app (${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}; ${clientVersion})`
  );
}

// --------------------------------------------------------------------------
// Auto-update suppression (Spec-005 §Required Behavior, 2026-08-26)
// --------------------------------------------------------------------------

describe("auto-update suppression in the spawned child", () => {
  it("declares an opt-out for EVERY driver, Codex's deliberately empty", () => {
    // Totality, not coverage: an omitted key and a deliberately-empty one must
    // not look alike. codex-cli documents no environment opt-out, and reaches
    // the same guarantee through the exact-build-path spawn.
    const drivers: readonly FlooredDriverName[] = Object.keys(
      DRIVER_CLI_VERSION_FLOORS,
    ) as FlooredDriverName[];
    expect(Object.keys(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV).sort()).toStrictEqual([...drivers].sort());
    expect(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV.claude).toStrictEqual({
      DISABLE_AUTOUPDATER: "1",
      DISABLE_UPDATES: "1",
    });
    expect(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV.codex).toStrictEqual({});
  });

  it("applies the opt-out OVER the inherited environment, so it cannot be re-enabled", () => {
    const composed = composeProviderChildEnvironment("claude", {
      PATH: "/usr/bin",
      DISABLE_AUTOUPDATER: "0",
    });
    expect(composed["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(composed["DISABLE_UPDATES"]).toBe("1");
    // Everything else passes through untouched — this seam decides one thing.
    expect(composed["PATH"]).toBe("/usr/bin");
  });

  it("carries the opt-out into the version handshake's own child", async () => {
    // The handshake spawn IS a driver-spawned child, so the obligation binds it
    // too: a build that auto-updated during its own version handshake would
    // falsify the reading that same handshake produced.
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

// --------------------------------------------------------------------------
// Executable resolution + the launcher-drift arm
// --------------------------------------------------------------------------

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

  // Symlink creation is unprivileged only on posix hosts; the win32 leg of
  // resolution is covered by the injected-seam cases below.
  describe.skipIf(process.platform === "win32")("against a real launcher symlink", () => {
    it("dereferences a launcher to the exact build path", async () => {
      const { launcherPath, buildPath } = await makeLauncherFixture();
      const resolved = await resolveProviderExecutable("claude", launcherPath);
      expect(resolved.requestedCommand).toBe(launcherPath);
      // `realpath` also resolves the temp root's own symlinks (macOS `/var` →
      // `/private/var`), so the assertion is on the FINAL COMPONENTS rather
      // than on a string-equal path.
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
      // The launcher-drift arm. The transport answers `2.1.245` for the
      // dereferenced build and `2.1.198` for the launcher path — the answer a
      // `claude --version` shell-out would have taken. The reading, and the two
      // binding carriers derived from it, must carry the BUILD's answer.
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
      // The launcher was never spawned — the drift cannot reach the reading.
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

  it("refuses an empty configured command rather than searching for one", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    await expect(
      resolveProviderExecutable("claude", "   ", { isExecutableFile: probe }),
    ).rejects.toBeInstanceOf(ProviderExecutableUnresolvableError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("expands PATHEXT on win32, where the executable-bit probe is inert", async () => {
    // The win32 LOGIC under test is the `PATHEXT` expansion and its ordering.
    // Path SYNTAX is `node:path`'s and is always the host platform's, so the
    // fixture uses host-shaped PATH entries rather than pretending a posix test
    // runner can canonicalize a drive-letter path.
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
    // The full candidate ORDER, observable only when nothing matches (the
    // resolver short-circuits on the first executable candidate). A stray
    // extensionless file must never shadow the real `.CMD` shim.
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

  it("falls back to the documented PATHEXT default when the environment carries none", async () => {
    const probed: string[] = [];
    await resolveProviderExecutable("claude", "claude", {
      platform: "win32",
      readEnvironment: () => ({ PATH: join("/tools") }),
      isExecutableFile: (candidate) => {
        probed.push(candidate);
        return Promise.resolve(candidate.endsWith(".EXE"));
      },
      realpath: (candidate) => Promise.resolve(candidate),
    });
    expect(probed.some((candidate) => candidate.endsWith("claude.EXE"))).toBe(true);
  });

  it("skips a candidate whose realpath fails rather than trusting the launcher path", async () => {
    // The candidate vanished between the probe and the dereference. Falling
    // back to the unresolved path would record exactly the launcher this module
    // exists to stop trusting, so the candidate is skipped instead.
    await expect(
      resolveProviderExecutable("claude", "/opt/bin/claude", {
        isExecutableFile: () => Promise.resolve(true),
        realpath: () => Promise.reject(new Error("ENOENT")),
      }),
    ).rejects.toBeInstanceOf(ProviderExecutableUnresolvableError);
  });
});

// --------------------------------------------------------------------------
// The two in-band channels
// --------------------------------------------------------------------------

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
    // The trap this rule exists for: the caller's own version (`0.9.0`) also
    // appears in the string, and a trailing-parenthetical parse returns it.
    const userAgent = codexUserAgent("0.149.1", "0.9.0");
    expect(extractCodexReportedVersion({ userAgent }, DEFAULT_PROVIDER_VERSION_CLIENT_NAME)).toBe(
      "0.149.1",
    );
  });

  it("refuses a userAgent whose leading token is not the name the daemon supplied", () => {
    // Shape drift, or another client's string. Guessing here is how a consumer
    // ends up reporting some other process's version as the provider's.
    const userAgent = `some-other-client/0.149.1 (macos; aarch64)`;
    expect(() =>
      extractCodexReportedVersion({ userAgent }, DEFAULT_PROVIDER_VERSION_CLIENT_NAME),
    ).toThrow(DriverCliVersionUnparseableError);
  });

  it("refuses a userAgent with no '/' delimiter at all", () => {
    expect(() =>
      extractCodexReportedVersion(
        { userAgent: `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME} 0.149.1` },
        DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
      ),
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

  it("accepts a pre-release token, which IS a canonical semver", () => {
    expect(
      extractCodexReportedVersion(
        { userAgent: `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}/0.150.0-alpha.1 (macos; aarch64)` },
        DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
      ),
    ).toBe("0.150.0-alpha.1");
  });

  it("refuses a reply carrying no userAgent as unparseable", () => {
    for (const payload of [undefined, null, {}, { userAgent: 7 }]) {
      expect(() =>
        extractCodexReportedVersion(payload, DEFAULT_PROVIDER_VERSION_CLIENT_NAME),
      ).toThrow(DriverCliVersionUnparseableError);
    }
  });

  it("refuses a daemon-supplied client name that breaks the extraction rule", () => {
    // A DAEMON obligation, so its violation is an internal-invariant Error and
    // not a provider refusal: a name carrying '/' or whitespace would make the
    // extraction ambiguous in the provider's favour.
    for (const badName of ["", "ai/sidekicks", "ai sidekicks"]) {
      expect(() =>
        extractCodexReportedVersion({ userAgent: codexUserAgent("0.149.1") }, badName),
      ).toThrow(/clientInfo\.name/);
    }
  });

  it("surfaces the WHOLE userAgent on the refusal, not the fragment it carved out", () => {
    const userAgent = `${DEFAULT_PROVIDER_VERSION_CLIENT_NAME}/v0.149.1 (macos; aarch64)`;
    let thrown: unknown;
    try {
      extractCodexReportedVersion({ userAgent }, DEFAULT_PROVIDER_VERSION_CLIENT_NAME);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DriverCliVersionUnparseableError);
    expect((thrown as DriverCliVersionUnparseableError).fields.raw).toBe(userAgent);
  });
});

// --------------------------------------------------------------------------
// The ratified floor gate at the spawn (I-005-10)
// --------------------------------------------------------------------------

describe("the ratified floor gate at the spawn (T3.23, I-005-10)", () => {
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
      sessionId: "session-attach",
      nodeId: "node-attach",
      reading,
      probe: probe.exchange,
      diagnostics: new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } }),
    });
  }

  it("refuses a below-floor build AFTER the handshake spawn and BEFORE any other use", async () => {
    // The ordering the task's Tests field states: the minimal handshake process
    // is permitted to spawn (the version is read in-band FROM it), and the
    // refusal precedes every use of that process beyond the handshake — no
    // declaration reaches the writer, and no second request reaches the process.
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
    // T3.24 joins "every use of that process beyond the handshake": a build the
    // daemon has already refused is never asked what it can do, so not even the
    // probe channel's negative control is issued against it.
    expect(probe.requests).toHaveLength(0);
  });

  it("admits the ratified floor itself", async () => {
    const handshake = new RecordingHandshake({
      [CODEX_EXECUTABLE]: { userAgent: codexUserAgent(DRIVER_CLI_VERSION_FLOORS.codex) },
    });
    const sink = new RecordingDeclarationSink();
    await attachCodex(sink, handshake);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.result.cliVersion.semver).toBe(DRIVER_CLI_VERSION_FLOORS.codex);
  });

  it("ATTACHES an above-the-pin build — newer-than-measured is not a refusal", async () => {
    // `Spec-005 §Required Behavior`: the floor comparison is the whole of the
    // version gate, and a build above the measured pin attaches.
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

  it("never spawns at all when the executable cannot be resolved", async () => {
    const handshake = new RecordingHandshake({});
    await expect(
      readSpawnedProviderVersion({
        driverName: "claude",
        requestedCommand: "claude",
        handshake: handshake.run,
        baseEnvironment: {},
        resolver: {
          readEnvironment: () => ({ PATH: "/nowhere" }),
          isExecutableFile: () => Promise.resolve(false),
        },
      }),
    ).rejects.toBeInstanceOf(ProviderExecutableUnresolvableError);
    expect(handshake.requests).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// The binding write persists THAT SAME reading
// --------------------------------------------------------------------------

describe("the binding carriers come from one reading (T3.23, EXTEND T2.2)", () => {
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
    // The failure this seam exists to make unreachable: a row recording one
    // install's version beside another install's path.
    expect(() =>
      withSpawnedVersionCarriers(
        { ...BASE_INPUT, spawnConfig: { resolvedExecutablePath: "/usr/local/bin/claude" } },
        toBindingVersionCarriers(READING),
      ),
    ).toThrow(/one reading/);
  });

  it("copies the report rather than aliasing the reading's own object", () => {
    const carriers = toBindingVersionCarriers(READING);
    expect(carriers.cliVersion).toStrictEqual(READING.report);
    expect(carriers.cliVersion).not.toBe(READING.report);
  });

  it("records a version the reading produced, never one a caller supplied", () => {
    // Type-level: `cliVersion` is omitted from the input, so the only way to
    // reach the column pair is through a reading. Runtime-level: a stray member
    // on an untyped caller's object is overwritten rather than honoured.
    const smuggled = {
      ...BASE_INPUT,
      cliVersion: { raw: "9.9.9", semver: "9.9.9" } satisfies DriverCliVersionReport,
    } as Omit<CreateRuntimeBindingInput, "cliVersion">;
    const input = withSpawnedVersionCarriers(smuggled, toBindingVersionCarriers(READING));
    expect(input.cliVersion).toStrictEqual({ raw: "2.1.245", semver: "2.1.245" });
  });
});

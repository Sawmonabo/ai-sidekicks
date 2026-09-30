/**
 * Claude capability declaration: explicit and total, so no caller reads support out of absence.
 * The flag record's totality is a compile-time check (its type annotation), so a flag added to the
 * contract union breaks this file before any test runs. What the writer stores is the writer's own
 * tests; here a fresh reading keyed to this driver must reach the sink, and the sink's verdict
 * must come back, both unaltered.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
} from "../../../__fixtures__/capability-probe-doubles.js";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../../driver-diagnostics.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../../../capability-refresh.js";
import type { DriverCapabilityDeclarationSink } from "../../../driver-capabilities-writer.js";
import { DRIVER_OUTPUT_SPEED_LEVELS } from "../../../driver-output-speed.js";
import {
  assertValidCapabilityFlags,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
} from "../../../provider-output-validation.js";
import type { SpawnedProviderVersionReading } from "../../../version-gate.js";
import {
  CLAUDE_CAPABILITY_CONTRACT_VERSION,
  CLAUDE_CAPABILITY_FLAGS,
  CLAUDE_DECLARED_MODEL_CATALOG,
  CLAUDE_DRIVER_NAME,
  CLAUDE_OUTPUT_SPEED_LEVELS,
  ClaudeCapabilityReporter,
  ClaudeModelCatalogUnreadableError,
  normalizeClaudeModelCatalog,
  resolveClaudeModelCatalog,
  type ClaudeTranscriptReplayReading,
  type ClaudeTranscriptSeedingSurface,
} from "../capabilities.js";
import { CLAUDE_TOOL_CATALOG } from "../tools.js";

const CLI_VERSION: DriverCliVersionReport = { raw: "2.1.245 (Claude Code)", semver: "2.1.245" };

// A Cellar path, not the `/opt/homebrew/bin/claude` launcher symlink: a reading never describes
// a launcher.
const RESOLVED_CLAUDE_EXECUTABLE = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";

function claudeReading(report: DriverCliVersionReport): SpawnedProviderVersionReading {
  return {
    driverName: CLAUDE_DRIVER_NAME,
    resolvedExecutablePath: RESOLVED_CLAUDE_EXECUTABLE,
    report,
  };
}

/** Diagnostics muted: this suite asserts declarations, not records. */
function silentDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
}

function makeReporter(
  readCliVersion: () => Promise<DriverCliVersionReport> = () => Promise.resolve({ ...CLI_VERSION }),
  probe: RecordingCapabilityProbeTransport = new RecordingCapabilityProbeTransport("claude"),
): ClaudeCapabilityReporter {
  return new ClaudeCapabilityReporter({
    readSpawnedVersion: async () => claudeReading(await readCliVersion()),
    // The default double answers every censused subtype and refuses the negative control; the
    // probe table, classifier and withdrawal paths are tested in
    // `provider/__tests__/capability-probe.test.ts`.
    probe: probe.exchange,
    // Silent: these assertions are about the declaration, not the diagnostics.
    diagnostics: silentDiagnostics(),
  });
}

describe("Claude capability declaration — explicit and total", () => {
  it("declares the capability matrix values exactly", () => {
    // The annotation makes this total: a flag added to the union breaks at compile time.
    const matrix: Record<DriverCapabilityFlag, boolean> = {
      resume: true,
      steer: false,
      interactive_requests: true,
      mcp: true,
      tool_calls: true,
      reasoning_stream: true,
      model_mutation: true,
      structured_output: true,
      rollback: true,
      session_goals: false,
      callback_tools: true,
      subagents: true,
      transcript_replay: false,
      context_compaction: true,
      provider_commands: true,
      output_speed: true,
    };
    expect(CLAUDE_CAPABILITY_FLAGS).toStrictEqual(matrix);
  });

  it("publishes the SETTABLE output-speed levels, which are not the reportable ones", () => {
    // The provider reports `on`, `cooldown` and `off`, but a user may only request `off` and `on`:
    // a cooldown is entered by the provider and cannot be asked for. Publishing `cooldown` here
    // would offer a level that cannot be honored; narrowing an observed `cooldown` into this set
    // would invent a state (see `ClaudeSessionLifecycle.observedOutputSpeedFor`).
    expect([...CLAUDE_OUTPUT_SPEED_LEVELS]).toStrictEqual(["off", "on"]);
    expect(CLAUDE_OUTPUT_SPEED_LEVELS).not.toContain("cooldown");
  });

  it("pins the two cells whose value is easy to get backwards", () => {
    expect(CLAUDE_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_CAPABILITY_FLAGS.reasoning_stream).toBe(true);
  });

  it("covers every canonical flag, with a boolean for each", () => {
    const declared = Object.keys(CLAUDE_CAPABILITY_FLAGS).sort();
    expect(declared).toStrictEqual([...DRIVER_CAPABILITY_FLAGS].sort());
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(Object.hasOwn(CLAUDE_CAPABILITY_FLAGS, flag)).toBe(true);
      expect(typeof CLAUDE_CAPABILITY_FLAGS[flag]).toBe("boolean");
    }
  });

  it("is accepted by the write seam's own totality guard", () => {
    // Runs the real validator the writer applies.
    expect(() => {
      assertValidCapabilityFlags(CLAUDE_CAPABILITY_FLAGS);
    }).not.toThrow();
  });

  it("declares no flag the contract does not carry", () => {
    // `transcript_replay` is probe-valued: the constant stays `false`, what an unprobed build
    // declares, and `getCapabilities` replaces it with the probe's answer.
    expect(CLAUDE_CAPABILITY_FLAGS.transcript_replay).toBe(false);
    const canonical = new Set<string>(DRIVER_CAPABILITY_FLAGS);
    for (const flag of Object.keys(CLAUDE_CAPABILITY_FLAGS)) {
      expect(canonical.has(flag)).toBe(true);
    }
  });

  it("carries a canonical, identifying contract version", () => {
    expect(() => {
      assertValidContractVersion(CLAUDE_CAPABILITY_CONTRACT_VERSION);
    }).not.toThrow();
  });

  it("spells the shared vocabulary table rather than copying it", () => {
    // Identity, not equality: the cache hydration path serves the same member with no driver in
    // hand, so both read one table.
    expect(CLAUDE_OUTPUT_SPEED_LEVELS).toBe(DRIVER_OUTPUT_SPEED_LEVELS.claude);
  });

  it("freezes the declared record, so a reader cannot rewrite it process-wide", () => {
    expect(Object.isFrozen(CLAUDE_CAPABILITY_FLAGS)).toBe(true);
  });

  it("names the driver with the daemon-controlled registry key", () => {
    expect(CLAUDE_DRIVER_NAME).toBe("claude");
  });
});

describe("getCapabilities() — the V1 result wrapper", () => {
  it("reports flags, contract version, tools, and the CLI version", async () => {
    const result: GetCapabilitiesResult = await makeReporter().getCapabilities();

    expect(result.capabilities.flags).toStrictEqual(CLAUDE_CAPABILITY_FLAGS);
    expect(result.capabilities.contractVersion).toBe(CLAUDE_CAPABILITY_CONTRACT_VERSION);
    expect(result.tools).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(result.cliVersion).toStrictEqual(CLI_VERSION);
    // A declared `output_speed` needs its published set, or the gate would admit every string.
    expect("outputSpeedLevels" in result).toBe(true);
    expect(result.outputSpeedLevels).toStrictEqual(["off", "on"]);
  });

  it("publishes the speed vocabulary as a fresh MUTABLE copy, never the frozen constant", async () => {
    // Two claims: the reply is mutable (a consumer extending its copy must not hit a TypeError
    // from the frozen constant), and that mutation reaches no other reader.
    const reporter = makeReporter();
    const first: GetCapabilitiesResult = await reporter.getCapabilities();

    expect(() => {
      first.outputSpeedLevels?.push("turbo");
    }).not.toThrow();

    const second: GetCapabilitiesResult = await reporter.getCapabilities();
    expect(second.outputSpeedLevels).toStrictEqual(["off", "on"]);
    expect(CLAUDE_OUTPUT_SPEED_LEVELS).toStrictEqual(["off", "on"]);
    expect(Object.isFrozen(CLAUDE_OUTPUT_SPEED_LEVELS)).toBe(true);
  });

  it("produces a wrapper the write seam's shape guard accepts", () => {
    return makeReporter()
      .getCapabilities()
      .then((result) => {
        expect(() => {
          assertValidGetCapabilitiesResultShape(result);
        }).not.toThrow();
      });
  });

  it("reports the injected CLI version verbatim, as a copy", async () => {
    const source: DriverCliVersionReport = { raw: "2.2.0-rc.1 (probe)", semver: "2.2.0-rc.1" };
    const result = await makeReporter(() => Promise.resolve(source)).getCapabilities();
    expect(result.cliVersion).toStrictEqual(source);
    expect(Object.is(result.cliVersion, source)).toBe(false);
  });

  it("re-reads the CLI version on every call (a report is never cached here)", async () => {
    const readCliVersion = vi.fn(() => Promise.resolve({ ...CLI_VERSION }));
    const reporter = makeReporter(readCliVersion);
    await reporter.getCapabilities();
    await reporter.getCapabilities();
    expect(readCliVersion).toHaveBeenCalledTimes(2);
  });

  it("hands out defensive copies — a mutated reply cannot rewrite the next one", async () => {
    const reporter = makeReporter();
    const first = await reporter.getCapabilities();

    first.capabilities.flags.reasoning_stream = false;
    first.capabilities.flags.steer = true;
    first.tools.length = 0;

    expect(CLAUDE_CAPABILITY_FLAGS.reasoning_stream).toBe(true);
    expect(CLAUDE_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_TOOL_CATALOG.length).toBeGreaterThan(0);

    const second = await reporter.getCapabilities();
    expect(second.capabilities.flags.reasoning_stream).toBe(true);
    expect(second.capabilities.flags.steer).toBe(false);
    expect(second.tools).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(Object.is(second.capabilities.flags, first.capabilities.flags)).toBe(false);
  });

  it("reports tools already class-closed — the floor holds at the wrapper", async () => {
    const result = await makeReporter().getCapabilities();
    expect(result.tools.length).toBe(CLAUDE_TOOL_CATALOG.length);
    for (const tool of result.tools) {
      expect(tool.idempotency_class).toBeDefined();
    }
  });

  it("propagates an in-band version read failure instead of reporting a partial wrapper", async () => {
    // The version comes from the spawned process's own `get_binary_version` answer, not a
    // `--version` shell-out; a failed read means the running build is unknown, so no wrapper.
    const reporter = makeReporter(() =>
      Promise.reject(new Error("in-band version handshake failed")),
    );
    await expect(reporter.getCapabilities()).rejects.toThrow("in-band version handshake failed");
  });
});

describe("refreshDeclaration() — the declaration seam", () => {
  it("hands the sink a fresh reading keyed to this driver", async () => {
    const sink = new RecordingDeclarationSink();
    const reporter = makeReporter();

    const verdict = await reporter.refreshDeclaration(sink);

    expect(sink.calls.length).toBe(1);
    const [call] = sink.calls;
    expect(call?.driverName).toBe(CLAUDE_DRIVER_NAME);
    expect(call?.result).toStrictEqual(await reporter.getCapabilities());
    expect(verdict).toStrictEqual({ snapshotChange: "created", cliVersionRefreshed: true });
  });

  it("returns the sink's verdict unaltered — change detection is the writer's", async () => {
    for (const snapshotChange of ["created", "changed", "unchanged"] as const) {
      const sink = new RecordingDeclarationSink({ snapshotChange, cliVersionRefreshed: false });
      const verdict = await makeReporter().refreshDeclaration(sink);
      expect(verdict).toStrictEqual({ snapshotChange, cliVersionRefreshed: false });
    }
  });

  it("re-reads the version on each refresh, so a CLI upgrade reaches the sink", async () => {
    const versions: DriverCliVersionReport[] = [
      { raw: "2.1.245", semver: "2.1.245" },
      { raw: "2.1.246", semver: "2.1.246" },
    ];
    let call = 0;
    const reporter = makeReporter(() => {
      const version = versions[Math.min(call, versions.length - 1)];
      call += 1;
      return Promise.resolve(version as DriverCliVersionReport);
    });
    const sink = new RecordingDeclarationSink();

    await reporter.refreshDeclaration(sink);
    await reporter.refreshDeclaration(sink);

    expect(sink.calls[0]?.result.cliVersion.semver).toBe("2.1.245");
    expect(sink.calls[1]?.result.cliVersion.semver).toBe("2.1.246");
  });

  it("does not swallow a sink failure", async () => {
    const failing: DriverCapabilityDeclarationSink = {
      declare: () => Promise.reject(new Error("write seam rejected the declaration")),
    };
    await expect(makeReporter().refreshDeclaration(failing)).rejects.toThrow(
      "write seam rejected the declaration",
    );
  });
});

describe("Claude CLI-version floor", () => {
  it("refuses a below-floor reading fail-closed before any report reaches a caller", async () => {
    // 2.1.198 is below the current 2.1.234 floor.
    const reporter = makeReporter(() =>
      Promise.resolve({ raw: "2.1.198 (Claude Code)", semver: "2.1.198" }),
    );
    let thrown: unknown;
    try {
      await reporter.getCapabilities();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverCliVersionBelowFloorError);
    const error = thrown as DriverCliVersionBelowFloorError;
    expect(error.code).toBe("driver.cli_version_below_floor");
    expect(error.fields).toStrictEqual({
      driverName: "claude",
      reportedSemver: "2.1.198",
      floor: DRIVER_CLI_VERSION_FLOORS.claude,
    });
  });

  it("admits the ratified floor itself and any newer build (above the pin included)", async () => {
    const atFloor = makeReporter(() =>
      Promise.resolve({ raw: "2.1.234 (Claude Code)", semver: "2.1.234" }),
    );
    await expect(atFloor.getCapabilities()).resolves.toBeDefined();

    const aboveMeasured = makeReporter(() => Promise.resolve({ raw: "3.0.0", semver: "3.0.0" }));
    await expect(aboveMeasured.getCapabilities()).resolves.toBeDefined();
  });

  it("refuses the refresh path through the same gate, and the writer never sees the declaration", async () => {
    const reporter = makeReporter(() =>
      Promise.resolve({ raw: "2.1.198 (Claude Code)", semver: "2.1.198" }),
    );
    const sink = new RecordingDeclarationSink();
    await expect(reporter.refreshDeclaration(sink)).rejects.toBeInstanceOf(
      DriverCliVersionBelowFloorError,
    );
    expect(sink.calls).toHaveLength(0);
  });

  it("refuses a non-canonical reading fail-closed as unparseable", async () => {
    // Reachable only through an untyped boundary; the gate still answers with a typed error.
    const reporter = makeReporter(() =>
      Promise.resolve({ raw: "Claude Code (unknown)", semver: "unknown" }),
    );
    await expect(reporter.getCapabilities()).rejects.toBeInstanceOf(
      DriverCliVersionUnparseableError,
    );
  });
});

describe("Claude composition is bound to the spawned build", () => {
  it("takes a reading of the spawned build rather than a bare report", async () => {
    // The reader returns a reading naming the resolved build, and its report is what the wrapper
    // carries.
    const readSpawnedVersion = vi.fn(() =>
      Promise.resolve(claudeReading({ raw: "2.1.246", semver: "2.1.246" })),
    );
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion,
      probe: new RecordingCapabilityProbeTransport("claude").exchange,
      diagnostics: silentDiagnostics(),
    });
    const result = await reporter.getCapabilities();

    expect(readSpawnedVersion).toHaveBeenCalledTimes(1);
    expect(result.cliVersion).toStrictEqual({ raw: "2.1.246", semver: "2.1.246" });
  });

  it("refuses a reading taken from ANOTHER driver's build", async () => {
    // A wiring fault, not provider misbehavior: a plain Error, and the sink is never called.
    const foreign: SpawnedProviderVersionReading = {
      driverName: "codex",
      resolvedExecutablePath: "/opt/homebrew/Cellar/codex/0.149.1/bin/codex",
      report: { raw: "0.149.1", semver: "0.149.1" },
    };
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(foreign),
      probe: new RecordingCapabilityProbeTransport("claude").exchange,
      diagnostics: silentDiagnostics(),
    });
    await expect(reporter.getCapabilities()).rejects.toThrow(/driver 'codex'/);

    const sink = new RecordingDeclarationSink();
    await expect(reporter.refreshDeclaration(sink)).rejects.toThrow(/driver 'codex'/);
    expect(sink.calls).toHaveLength(0);
  });
});

/**
 * The verbatim `list_models` control-response payload from Claude Code 2.1.251, recorded from one
 * zero-turn `{"subtype":"list_models"}` request over `-p --input-format stream-json`. Real bytes,
 * so the two wire quirks are tested against what produced them: the `default` pointer sharing
 * `opus[1m]`'s `resolvedModel`, and the Haiku row publishing no effort surface.
 */
const CLAUDE_RECORDED_LIST_MODELS_REPLY: Readonly<Record<string, unknown>> = Object.freeze({
  models: [
    {
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      description: "Opus 5 with 1M context · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus (1M context)",
      description: "Opus 5 with 1M context · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-fable-5",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
      description: "Fable 5 · Most capable for your hardest and longest-running tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    // No effort fields: the model exposes no effort selection.
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers",
    },
  ],
});

describe("Claude model catalog", () => {
  it("reads the recorded reply into four models keyed by resolvedModel", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    // Five wire rows, four models: `default` and `opus[1m]` resolve to one.
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5[1m]",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    // Alias values never become ids: a provider switch validates its model against this list,
    // and an alias like `sonnet` or `default` can move underneath the user who chose it.
    for (const aliasValue of ["default", "opus[1m]", "sonnet", "haiku"]) {
      expect(models.map((model) => model.id)).not.toContain(aliasValue);
    }
  });

  it("keeps the naming row over the reserved default pointer", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);
    const opus = models.find((model) => model.id === "claude-opus-5[1m]");

    // Not "Default (recommended)": that names the current default and would re-label whichever
    // model is promoted next.
    expect(opus?.name).toBe("Opus (1M context)");
  });

  it("prefers the naming row whichever order it arrives in", () => {
    const pointerLast = {
      models: [
        (CLAUDE_RECORDED_LIST_MODELS_REPLY["models"] as Record<string, unknown>[])[1],
        (CLAUDE_RECORDED_LIST_MODELS_REPLY["models"] as Record<string, unknown>[])[0],
      ],
    };

    const models = normalizeClaudeModelCatalog(pointerLast);

    // The recorded build sends the pointer first; the rule must not depend on that order.
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Opus (1M context)");
  });

  it("keeps the pointer row when it is a model's only row", () => {
    const pointerOnly = {
      models: [(CLAUDE_RECORDED_LIST_MODELS_REPLY["models"] as Record<string, unknown>[])[0]],
    };

    const models = normalizeClaudeModelCatalog(pointerOnly);

    // Dropping it would lose the model, which is worse than carrying the pointer's name.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("claude-opus-5[1m]");
  });

  it("carries each model's published effort levels verbatim", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    for (const modelId of ["claude-opus-5[1m]", "claude-fable-5", "claude-sonnet-5"]) {
      const model = models.find((candidate) => candidate.id === modelId);
      // Levels, `xhigh` included, are read from the build, not from a fixed vocabulary.
      expect(model?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("leaves effortLevels ABSENT for a model with no effort surface", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);
    const haiku = models.find((model) => model.id === "claude-haiku-4-5-20251001");

    // Absent, not empty: absence means "no effort selection"; an empty array would claim an axis.
    expect(haiku).toBeDefined();
    expect(haiku && "effortLevels" in haiku).toBe(false);
    expect(haiku?.effortLevels).toBeUndefined();
  });

  it("reads each model's fast mode from its own supportsFastMode", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    // Only the Opus row publishes a fast mode in the recorded reply; a row with no flag has none.
    expect(models.map((model) => [model.id, model.fast])).toEqual([
      ["claude-opus-5[1m]", true],
      ["claude-fable-5", false],
      ["claude-sonnet-5", false],
      ["claude-haiku-4-5-20251001", false],
    ]);
  });

  it("suppresses effortLevels when the row explicitly denies effort support", () => {
    const models = normalizeClaudeModelCatalog({
      models: [
        {
          value: "x",
          resolvedModel: "model-x",
          displayName: "X",
          supportsEffort: false,
          supportedEffortLevels: ["low", "high"],
        },
      ],
    });

    expect(models[0]?.effortLevels).toBeUndefined();
  });

  it("populates no capabilities tags", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    // No vocabulary is registered for the tags and nothing reads them, so the row's
    // `supportsAdaptiveThinking`, `supportsFastMode` and `supportsAutoMode` are not mapped to them.
    for (const model of models) {
      expect(model.capabilities).toEqual([]);
    }
  });

  it.each([
    ["a non-object reply", null, /not an object/],
    ["a reply with no models array", { models: "many" }, /no `models` array/],
    ["a non-object entry", { models: ["sonnet"] }, /entry is not an object/],
    ["an entry with no resolvedModel", { models: [{ displayName: "X" }] }, /no `resolvedModel`/],
    [
      "an entry with no displayName",
      { models: [{ resolvedModel: "model-x" }] },
      /no `displayName`/,
    ],
    [
      "a non-string effort level",
      { models: [{ resolvedModel: "model-x", displayName: "X", supportedEffortLevels: [7] }] },
      /non-string effort level/,
    ],
    [
      "a fast-mode flag that is not a boolean",
      { models: [{ resolvedModel: "model-x", displayName: "X", supportsFastMode: "yes" }] },
      /unreadable `supportsFastMode`/,
    ],
  ])("refuses %s", (_label, payload, message) => {
    // Strict: skipping a bad row would answer a short catalog that looks like a provider dropping
    // a model.
    expect(() => normalizeClaudeModelCatalog(payload)).toThrow(ClaudeModelCatalogUnreadableError);
    expect(() => normalizeClaudeModelCatalog(payload)).toThrow(message);
  });

  it("answers the declared catalog when no exchange is bound", async () => {
    const models = await resolveClaudeModelCatalog(null);

    expect(models.map((model) => model.id)).toEqual(
      CLAUDE_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
    // The declaration must equal the recorded reply, so drift fails here.
    expect(models).toEqual(normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY));
  });

  it("refuses an in-place mutation of the shared declared catalog", () => {
    // A shallow freeze stops `entry.effortLevels = […]` but not `entry.effortLevels.push(…)`,
    // and this constant is shared process-wide, so the arrays must be frozen too.
    const declaredEntry = CLAUDE_DECLARED_MODEL_CATALOG[0];
    if (declaredEntry === undefined) {
      throw new Error("the declared catalog is empty");
    }

    expect(Object.isFrozen(declaredEntry)).toBe(true);
    expect(Object.isFrozen(declaredEntry.capabilities)).toBe(true);
    expect(Object.isFrozen(declaredEntry.effortLevels)).toBe(true);
    expect(Object.isFrozen(CLAUDE_DECLARED_MODEL_CATALOG)).toBe(true);
    // Modules are strict, so a write to a frozen array throws.
    expect(() => declaredEntry.effortLevels?.push("mutated")).toThrow(TypeError);
    expect(() => declaredEntry.capabilities.push("mutated")).toThrow(TypeError);

    expect(declaredEntry.capabilities).toStrictEqual([]);
    expect(declaredEntry.effortLevels).toStrictEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("freezes the no-effort row's capabilities too, not only the effort-bearing ones", () => {
    // The effort-free row is built on a different branch, which could miss the freeze.
    const noEffortEntry = CLAUDE_DECLARED_MODEL_CATALOG.find(
      (model) => model.effortLevels === undefined,
    );
    if (noEffortEntry === undefined) {
      throw new Error("the declared catalog carries no effort-free row");
    }

    expect(Object.isFrozen(noEffortEntry.capabilities)).toBe(true);
    expect(() => noEffortEntry.capabilities.push("mutated")).toThrow(TypeError);
  });

  it("hands out fresh copies of the declared catalog", async () => {
    const first = await resolveClaudeModelCatalog(null);
    first[0]?.capabilities.push("mutated");
    first[0]?.effortLevels?.push("mutated");

    const second = await resolveClaudeModelCatalog(null);

    // The constant is frozen and shared, but `ProviderModel` has mutable arrays, so each caller
    // gets its own copy.
    expect(second[0]?.capabilities).toEqual([]);
    expect(second[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("prefers a bound exchange over the declaration", async () => {
    const models = await resolveClaudeModelCatalog(async () => ({
      models: [{ value: "z", resolvedModel: "model-z", displayName: "Z" }],
    }));

    expect(models).toEqual([{ id: "model-z", name: "Z", capabilities: [], fast: false }]);
  });

  it("never falls back to the declaration when a bound exchange fails", async () => {
    const transportFailure = new Error("channel closed");

    // A stale catalog must never be served as if it were a live read.
    await expect(
      resolveClaudeModelCatalog(async () => {
        throw transportFailure;
      }),
    ).rejects.toBe(transportFailure);
    await expect(resolveClaudeModelCatalog(async () => ({ notModels: [] }))).rejects.toThrow(
      ClaudeModelCatalogUnreadableError,
    );
  });
});

// `transcript_replay` is the one probe-valued flag: the declaration must follow the probe in
// both directions, or a suite that only ran the refusing double would pass on a hard-coded `false`.
describe("ClaudeCapabilityReporter — the probe-derived transcript_replay declaration", () => {
  const SEEDING_SURFACE: ClaudeTranscriptSeedingSurface = {
    seedFrame: () => Promise.resolve({ delivery: "applied" as const }),
    readBack: () => Promise.resolve({ kind: "turns" as const, turns: [] }),
  };

  function reporterWithReplayProbe(
    reading: () => Promise<ClaudeTranscriptReplayReading>,
  ): ClaudeCapabilityReporter {
    return new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(claudeReading({ ...CLI_VERSION })),
      probe: new RecordingCapabilityProbeTransport("claude").exchange,
      diagnostics: silentDiagnostics(),
      transcriptReplayProbe: reading,
    });
  }

  it("declares FALSE when the probe finds no seeding surface on the build", async () => {
    const reporter = reporterWithReplayProbe(() =>
      Promise.resolve({
        supported: false,
        reason: "this build publishes no prior-turn seeding contract",
      }),
    );
    const result = await reporter.getCapabilities();
    expect(result.capabilities.flags.transcript_replay).toBe(false);
  });

  it("declares TRUE when the probe finds one — the declaration follows the probe UP", async () => {
    const reporter = reporterWithReplayProbe(() =>
      Promise.resolve({ supported: true, surface: SEEDING_SURFACE }),
    );
    const result = await reporter.getCapabilities();
    expect(result.capabilities.flags.transcript_replay).toBe(true);
  });

  // Whichever way the probe answers, the declaration is that answer, never the module constant.
  it("tracks a probe that flips, in both directions", async () => {
    let supported = false;
    const reporter = reporterWithReplayProbe(() =>
      Promise.resolve(
        supported
          ? { supported: true, surface: SEEDING_SURFACE }
          : { supported: false, reason: "not yet" },
      ),
    );
    const before = await reporter.getCapabilities();
    expect(before.capabilities.flags.transcript_replay).toBe(false);

    supported = true;
    const after = await reporter.getCapabilities();
    expect(after.capabilities.flags.transcript_replay).toBe(true);

    supported = false;
    const again = await reporter.getCapabilities();
    expect(again.capabilities.flags.transcript_replay).toBe(false);
  });

  it("declares FALSE with no probe bound, which is this pin's honest answer", async () => {
    const result = await makeReporter().getCapabilities();
    expect(result.capabilities.flags.transcript_replay).toBe(false);
  });

  // A faulted probe fails closed to `false` and records a diagnostic, since the flag alone cannot
  // tell it from a probe that answered no.
  it("fails closed AND records a diagnostic when the probe throws", async () => {
    const emitted: DriverDiagnosticRecord[] = [];
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(claudeReading({ ...CLI_VERSION })),
      probe: new RecordingCapabilityProbeTransport("claude").exchange,
      diagnostics: new DriverDiagnosticsEmitter({
        logSink: { record: (record) => emitted.push(record) },
      }),
      transcriptReplayProbe: () => Promise.reject(new Error("probe transport died")),
    });
    const result = await reporter.getCapabilities();
    expect(result.capabilities.flags.transcript_replay).toBe(false);
    const withdrawal = emitted.find((record) => record.details["flag"] === "transcript_replay");
    expect(withdrawal?.kind).toBe("capability_flag_withdrawn");
    expect(withdrawal?.details["disposition"]).toBe("probe-faulted");
  });

  // The supported arm carries the surface, so "declared true with nothing behind it" cannot be
  // represented.
  it("cannot represent a supported reading with no seeding surface", () => {
    const supported: ClaudeTranscriptReplayReading = {
      supported: true,
      surface: SEEDING_SURFACE,
    };
    expect(supported.supported && supported.surface).toBeDefined();
    // @ts-expect-error a supported reading without a surface does not type-check
    const impossible: ClaudeTranscriptReplayReading = { supported: true };
    expect(impossible.supported).toBe(true);
  });
});

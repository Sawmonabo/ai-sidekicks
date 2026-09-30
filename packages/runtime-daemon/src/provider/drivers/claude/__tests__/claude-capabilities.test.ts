// Claude capability declaration: the declared flag matrix; a reporter that admits any build at or
// above the floor and refuses a below-floor, unparseable or foreign one before the writer sees it;
// the model catalog read from the recorded `list_models` reply; and the probed `transcript_replay`.

import { describe, expect, it } from "vitest";

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";

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
import type { SpawnedProviderVersionReading } from "../../../version-gate.js";
import {
  CLAUDE_CAPABILITY_CONTRACT_VERSION,
  CLAUDE_CAPABILITY_FLAGS,
  CLAUDE_DRIVER_NAME,
  ClaudeCapabilityReporter,
  ClaudeModelCatalogUnreadableError,
  normalizeClaudeModelCatalog,
  resolveClaudeModelCatalog,
  type ClaudeTranscriptReplayReading,
  type ClaudeTranscriptSeedingSurface,
} from "../capabilities.js";
import { CLAUDE_TOOL_CATALOG } from "../tools.js";
import { makeSilentDriverDiagnostics } from "./claude-test-doubles.js";
import type { DriverCliVersionReport, GetCapabilitiesResult } from "../../../provider-driver.js";

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

function makeReporter(
  readCliVersion: () => Promise<DriverCliVersionReport> = () => Promise.resolve({ ...CLI_VERSION }),
  probe: RecordingCapabilityProbeTransport = new RecordingCapabilityProbeTransport("claude"),
): ClaudeCapabilityReporter {
  return new ClaudeCapabilityReporter({
    readSpawnedVersion: async () => claudeReading(await readCliVersion()),
    // The default double answers every probed subtype and refuses the negative control; the probe
    // itself is tested in `provider/__tests__/capability-probe.test.ts`.
    probe: probe.exchange,
    // Silent: these assertions are about the declaration, not the diagnostics.
    diagnostics: makeSilentDriverDiagnostics(),
  });
}

describe("Claude capability declaration", () => {
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
});

describe("getCapabilities()", () => {
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
});

describe("refreshDeclaration()", () => {
  it("re-reads the version on each refresh, so a CLI upgrade reaches the sink under this driver", async () => {
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

    expect(sink.calls.map((call) => call.driverName)).toStrictEqual([
      CLAUDE_DRIVER_NAME,
      CLAUDE_DRIVER_NAME,
    ]);
    expect(sink.calls[0]?.result.cliVersion.semver).toBe("2.1.245");
    expect(sink.calls[1]?.result.cliVersion.semver).toBe("2.1.246");
  });
});

describe("Claude CLI-version floor", () => {
  it("refuses a below-floor reading before any report reaches a caller or the writer", async () => {
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

    // The refresh path goes through the same gate, so the writer never sees the declaration.
    const sink = new RecordingDeclarationSink();
    await expect(reporter.refreshDeclaration(sink)).rejects.toBeInstanceOf(
      DriverCliVersionBelowFloorError,
    );
    expect(sink.calls).toHaveLength(0);
  });

  it("admits a build exactly at the floor and any newer build, above the pin included", async () => {
    const atFloor = makeReporter(() =>
      Promise.resolve({ raw: "2.1.234 (Claude Code)", semver: "2.1.234" }),
    );
    await expect(atFloor.getCapabilities()).resolves.toBeDefined();

    const aboveMeasured = makeReporter(() => Promise.resolve({ raw: "3.0.0", semver: "3.0.0" }));
    await expect(aboveMeasured.getCapabilities()).resolves.toBeDefined();
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
      diagnostics: makeSilentDriverDiagnostics(),
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
  it("reads the recorded reply into four models by resolvedModel, with names, effort and fast mode", () => {
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

    // Not "Default (recommended)": that names the current default and would re-label whichever
    // model is promoted next.
    expect(models.find((model) => model.id === "claude-opus-5[1m]")?.name).toBe(
      "Opus (1M context)",
    );

    for (const modelId of ["claude-opus-5[1m]", "claude-fable-5", "claude-sonnet-5"]) {
      const model = models.find((candidate) => candidate.id === modelId);
      // Levels, `xhigh` included, are read from the build, not from a fixed vocabulary.
      expect(model?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }

    // Absent, not empty: absence means "no effort selection"; an empty array would claim an axis.
    const haiku = models.find((model) => model.id === "claude-haiku-4-5-20251001");
    expect(haiku).toBeDefined();
    expect(haiku && "effortLevels" in haiku).toBe(false);
    expect(haiku?.effortLevels).toBeUndefined();

    // Only the Opus row publishes a fast mode in the recorded reply; a row with no flag has none.
    expect(models.map((model) => [model.id, model.fast])).toEqual([
      ["claude-opus-5[1m]", true],
      ["claude-fable-5", false],
      ["claude-sonnet-5", false],
      ["claude-haiku-4-5-20251001", false],
    ]);
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
      diagnostics: makeSilentDriverDiagnostics(),
      transcriptReplayProbe: reading,
    });
  }

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
});

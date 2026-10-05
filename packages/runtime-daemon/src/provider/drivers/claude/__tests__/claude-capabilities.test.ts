// Claude capability declaration: a reporter that carries the spawned build's version and its
// output-speed levels and refuses a foreign one before the writer sees it; and the model catalog
// read from the recorded `list_models` reply.

import { describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
} from "../../../__fixtures__/capability-probe-doubles.js";
import {
  claudeDefaultProbeReply,
  claudeSuccessReply,
} from "../__fixtures__/capability-probe-replies.js";
import type { SpawnedProviderVersionReading } from "../../../spawned-provider-version.js";
import {
  CLAUDE_DRIVER_NAME,
  ClaudeCapabilityReporter,
  normalizeClaudeModelCatalog,
  resolveClaudeModelCatalog,
} from "../capabilities.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import { DriverCapabilityCache } from "../../../capability-cache.js";
import {
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
  ModelCatalogUnreadableError,
} from "../../../provider-driver.js";

const CLI_VERSION: DriverCliVersionReport = {
  rawVersion: "2.1.245 (Claude Code)",
  parsedVersion: "2.1.245",
};

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
  probe: RecordingCapabilityProbeTransport = new RecordingCapabilityProbeTransport(
    claudeDefaultProbeReply,
  ),
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

describe("getCapabilities()", () => {
  it("reports the CLI version it read and the output-speed levels", async () => {
    const result: GetCapabilitiesResult = await makeReporter().getCapabilities();

    expect(result.cliVersion).toStrictEqual(CLI_VERSION);
    // A declared `output_speed` needs its published set, or the gate would admit every string.
    expect("outputSpeedLevels" in result).toBe(true);
    expect(result.outputSpeedLevels).toStrictEqual(["off", "on"]);

    // The durable row stores no levels, yet every cache-served reply carries the live read's.
    const { outputSpeedLevels: _unstored, ...durableResult } = result;
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => ({ hit: true, result: durableResult }),
    });
    expect(cache.read(CLAUDE_DRIVER_NAME).outputSpeedLevels).toStrictEqual(
      result.outputSpeedLevels,
    );
    expect(cache.read(CLAUDE_DRIVER_NAME).outputSpeedLevels).toStrictEqual(
      result.outputSpeedLevels,
    );
  });

  it("withdraws the speed axis and its levels when `initialize` reports no state", async () => {
    // Levels for a withdrawn axis would offer a choice the provider cannot honor.
    const probe = new RecordingCapabilityProbeTransport(claudeDefaultProbeReply, {
      replies: { initialize: claudeSuccessReply() },
    });
    const result = await makeReporter(undefined, probe).getCapabilities();

    expect(result.capabilities.flags.output_speed).toBe(false);
    expect(Object.hasOwn(result, "outputSpeedLevels")).toBe(false);
  });
});

describe("refreshDeclaration()", () => {
  it(
    "re-reads the version on each refresh, so a " +
      "CLI upgrade reaches the sink under this driver",
    async () => {
      const versions: DriverCliVersionReport[] = [
        { rawVersion: "2.1.245", parsedVersion: "2.1.245" },
        { rawVersion: "2.1.246", parsedVersion: "2.1.246" },
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
      expect(sink.calls[0]?.result.cliVersion.parsedVersion).toBe("2.1.245");
      expect(sink.calls[1]?.result.cliVersion.parsedVersion).toBe("2.1.246");
    },
  );
});

describe("Claude composition is bound to the spawned build", () => {
  it("refuses a reading taken from ANOTHER driver's build", async () => {
    // A wiring fault, not provider misbehavior: a plain Error, and the sink is never called.
    const foreign: SpawnedProviderVersionReading = {
      driverName: "codex",
      resolvedExecutablePath: "/opt/homebrew/Cellar/codex/0.149.1/bin/codex",
      report: { rawVersion: "0.149.1", parsedVersion: "0.149.1" },
    };
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(foreign),
      probe: new RecordingCapabilityProbeTransport(claudeDefaultProbeReply).exchange,
      diagnostics: makeSilentDriverDiagnostics(),
    });
    await expect(reporter.getCapabilities()).rejects.toThrow(/driver 'codex'/);

    const sink = new RecordingDeclarationSink();
    await expect(reporter.refreshDeclaration(sink)).rejects.toThrow(/driver 'codex'/);
    expect(sink.calls).toHaveLength(0);
  });
});

/**
 * The verbatim `list_models` control-response payload from Claude Code 2.1.287, recorded on Oct 2,
 * 2026 from one zero-turn `{"subtype":"list_models"}` request over `-p --input-format stream-json`.
 * Real bytes, so the wire quirks are tested against what produced them: the `default` pointer
 * sharing `opus`'s `resolvedModel`, two effort vocabularies, and the Haiku row publishing no effort
 * surface.
 */
const CLAUDE_RECORDED_LIST_MODELS_REPLY: Readonly<Record<string, unknown>> = Object.freeze({
  models: [
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)",
      description: "Opus 5.5 · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus 5.5",
      description: "For complex work and everyday tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "fable",
      resolvedModel: "claude-fable-5-1",
      displayName: "Fable 5.1",
      description: "For your toughest challenges",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5-5",
      displayName: "Sonnet 5.5",
      description: "Most efficient for simpler tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    // No effort fields: the model exposes no effort selection.
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku 4.5",
      description: "Fastest for quick answers",
    },
    {
      value: "claude-sonnet-5",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet 5",
      description: "Efficient for routine tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-opus-5",
      resolvedModel: "claude-opus-5",
      displayName: "Opus 5",
      description: "Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-fable-5",
      resolvedModel: "claude-fable-5",
      displayName: "Fable 5",
      description: "Most capable for your hardest and longest-running tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-opus-4-8",
      resolvedModel: "claude-opus-4-8",
      displayName: "Opus 4.8",
      description: "Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-opus-4-7",
      resolvedModel: "claude-opus-4-7",
      displayName: "Opus 4.7",
      description: "Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-opus-4-6",
      resolvedModel: "claude-opus-4-6",
      displayName: "Opus 4.6",
      description: "Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
      displayName: "Sonnet 4.6",
      description: "Efficient for routine tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
  ],
});

describe("Claude model catalog", () => {
  it(
    "reads the recorded reply into eleven models by resolvedModel, with names, effort and fast " +
      "mode",
    () => {
      const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

      // Twelve wire rows, eleven models: `default` and `opus` resolve to one.
      expect(models.map((model) => model.id)).toEqual([
        "claude-opus-5-5",
        "claude-fable-5-1",
        "claude-sonnet-5-5",
        "claude-haiku-4-5-20251001",
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
      ]);
      // Alias values never become ids: a provider switch validates its model against this list,
      // and an alias like `sonnet` or `default` can move underneath the user who chose it.
      for (const aliasValue of ["default", "opus", "fable", "sonnet", "haiku"]) {
        expect(models.map((model) => model.id)).not.toContain(aliasValue);
      }

      // Not "Default (recommended)": that names the current default and would re-label whichever
      // model is promoted next.
      expect(models.find((model) => model.id === "claude-opus-5-5")?.name).toBe("Opus 5.5");

      // Levels are read from the build, not from a fixed vocabulary: `xhigh` is on some rows only.
      const levelsFor = (id: string): string[] | undefined =>
        models.find((model) => model.id === id)?.effortLevels;
      expect(levelsFor("claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(levelsFor("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);

      // Absent, not empty: absence means "no effort selection"; an empty array would claim an axis.
      const haiku = models.find((model) => model.id === "claude-haiku-4-5-20251001");
      expect(haiku).toBeDefined();
      expect(haiku && "effortLevels" in haiku).toBe(false);
      expect(haiku?.effortLevels).toBeUndefined();

      // Only rows carrying `supportsFastMode: true` publish a fast mode; a row with no flag has
      // none.
      expect(models.filter((model) => model.fast).map((model) => model.id)).toEqual([
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-opus-4-8",
      ]);
    },
  );

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
    expect(models[0]?.name).toBe("Opus 5.5");
  });

  it("keeps the pointer row when it is a model's only row", () => {
    const pointerOnly = {
      models: [(CLAUDE_RECORDED_LIST_MODELS_REPLY["models"] as Record<string, unknown>[])[0]],
    };

    const models = normalizeClaudeModelCatalog(pointerOnly);

    // Dropping it would lose the model, which is worse than carrying the pointer's name.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("claude-opus-5-5");
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
    expect(() => normalizeClaudeModelCatalog(payload)).toThrow(ModelCatalogUnreadableError);
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
      ModelCatalogUnreadableError,
    );
  });
});

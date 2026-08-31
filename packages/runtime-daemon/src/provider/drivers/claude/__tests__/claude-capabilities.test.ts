/**
 * Plan-005 T3.8 — Claude capability declaration (I-005-2, CP-005-5).
 *
 * The invariant is that the declaration is EXPLICIT and TOTAL, and that no
 * caller may read support out of absence. The strongest assertion here is a
 * COMPILE-time one and says so where it appears: the flag record's totality is
 * enforced by its type annotation, so a flag added to the contract union
 * breaks this file and the module before any test runs. The sink's conformance
 * to `DriverCapabilitiesWriter` needs no assertion at all now that the type is
 * a `Pick` of the writer — the fake below carries that check by `implements`.
 *
 * What is deliberately NOT asserted here: that a
 * `runtime_node.capability_declared` / `capability_updated` event reaches the
 * log. That emission is `DriverCapabilitiesWriter`'s (Plan-005 T2.4) and is
 * covered by its own tests; a typed fake observes the CALL, never the event.
 * What this file asserts about the refresh trigger is exactly what it owns —
 * that a fresh reading, keyed to this driver, reaches the sink unaltered, and
 * that the sink's verdict is returned unaltered.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import { RecordingCapabilityProbeTransport } from "../../../__fixtures__/capability-probe-doubles.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
} from "../../../driver-capabilities-writer.js";
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
  ClaudeCapabilityReporter,
  ClaudeModelCatalogUnreadableError,
  normalizeClaudeModelCatalog,
  resolveClaudeModelCatalog,
  type DriverCapabilityDeclarationSink,
} from "../capabilities.js";
import { CLAUDE_TOOL_CATALOG } from "../tools.js";

const CLI_VERSION: DriverCliVersionReport = { raw: "2.1.245 (Claude Code)", semver: "2.1.245" };

// The build a T3.23 reading names — a Cellar path, deliberately NOT the
// `/opt/homebrew/bin/claude` launcher symlink that points at it, because a
// launcher is precisely what the reading refuses to describe.
const RESOLVED_CLAUDE_EXECUTABLE = "/opt/homebrew/Cellar/claude/2.1.245/bin/claude";

function claudeReading(report: DriverCliVersionReport): SpawnedProviderVersionReading {
  return {
    driverName: CLAUDE_DRIVER_NAME,
    resolvedExecutablePath: RESOLVED_CLAUDE_EXECUTABLE,
    report,
  };
}

/**
 * The reporter takes a `SpawnedProviderVersionReading` reader since T3.23. The
 * suite keeps expressing cases as REPORTS and wraps each into a reading here, so
 * every existing assertion still says what it always said about the version,
 * while the reporter's dependency is exercised in its shipped shape.
 */
/** The diagnostic band, muted: this suite asserts declarations, not records. */
function silentDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
}

function makeReporter(
  readCliVersion: () => Promise<DriverCliVersionReport> = () => Promise.resolve({ ...CLI_VERSION }),
  probe: RecordingCapabilityProbeTransport = new RecordingCapabilityProbeTransport("claude"),
): ClaudeCapabilityReporter {
  return new ClaudeCapabilityReporter({
    readSpawnedVersion: async () => claudeReading(await readCliVersion()),
    // T3.24: the probe transport is a REQUIRED dependency, so a reporter that
    // declares provenance nobody measured cannot be constructed. The default
    // double answers every censused subtype and refuses the negative control,
    // which is the happy path these pre-existing assertions assume; the probe
    // table, the classifier, and the withdrawal paths are exercised in
    // `provider/__tests__/capability-probe.test.ts`.
    probe: probe.exchange,
    // Likewise REQUIRED: a withdrawal a build never reports is a capability
    // silently lost. Silent here, because these assertions are about the
    // declaration rather than about the diagnostic band.
    diagnostics: silentDiagnostics(),
  });
}

/**
 * A typed fake of the ONE writer method this seam uses: it records what the
 * refresh trigger hands the writer. Typing it as
 * `DriverCapabilityDeclarationSink` (a `Pick` of the real class) means a
 * signature change on `DriverCapabilitiesWriter.declare` breaks this file at
 * compile time instead of leaving a stale fake passing.
 */
class RecordingDeclarationSink implements DriverCapabilityDeclarationSink {
  readonly calls: DeclareDriverCapabilitiesInput[] = [];
  #verdict: DeclareDriverCapabilitiesResult;

  constructor(
    verdict: DeclareDriverCapabilitiesResult = { emitted: "declared", cliVersionRefreshed: true },
  ) {
    this.#verdict = verdict;
  }

  declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    this.calls.push(input);
    return Promise.resolve(this.#verdict);
  }
}

describe("Claude capability declaration — explicit and total (I-005-2)", () => {
  it("declares the Spec-005 matrix values exactly", () => {
    // Transcribed from Spec-005 §Per-Driver Capability Matrix (Claude column).
    // The annotation makes this expectation total too: a flag added to the
    // union breaks this test at COMPILE time, not on a silent `false`.
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
      session_goals: true,
      callback_tools: true,
      subagents: true,
      transcript_replay: false,
      cost_cap: true,
    };
    expect(CLAUDE_CAPABILITY_FLAGS).toStrictEqual(matrix);
  });

  it("pins the three cells whose value is easy to get backwards", () => {
    expect(CLAUDE_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_CAPABILITY_FLAGS.reasoning_stream).toBe(true);
    expect(CLAUDE_CAPABILITY_FLAGS.cost_cap).toBe(true);
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
    // Drives the real guard rather than restating its rule: a declaration this
    // module ships must survive the validator the writer applies to it.
    expect(() => {
      assertValidCapabilityFlags(CLAUDE_CAPABILITY_FLAGS);
    }).not.toThrow();
  });

  it("declares no flag the contract does not carry", () => {
    // `transcript_replay` is now in the union, and its Spec-005 Claude cell is
    // `probe` rather than a value — so the declaration is `false` until the
    // driver-side replay leg probes the installed build. Undeclared and
    // declared-unsupported must be indistinguishable to a caller.
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

    first.capabilities.flags.cost_cap = false;
    first.capabilities.flags.steer = true;
    first.tools.length = 0;

    expect(CLAUDE_CAPABILITY_FLAGS.cost_cap).toBe(true);
    expect(CLAUDE_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_TOOL_CATALOG.length).toBeGreaterThan(0);

    const second = await reporter.getCapabilities();
    expect(second.capabilities.flags.cost_cap).toBe(true);
    expect(second.capabilities.flags.steer).toBe(false);
    expect(second.tools).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(Object.is(second.capabilities.flags, first.capabilities.flags)).toBe(false);
  });

  it("reports tools already class-closed (I-005-3 holds at the wrapper)", async () => {
    const result = await makeReporter().getCapabilities();
    expect(result.tools.length).toBe(CLAUDE_TOOL_CATALOG.length);
    for (const tool of result.tools) {
      expect(tool.idempotency_class).toBeDefined();
    }
  });

  it("propagates an in-band version read failure instead of reporting a partial wrapper", async () => {
    // The read is the spawned process's own `get_binary_version` answer since
    // T3.23 — never a `--version` shell-out — so a failed read means the daemon
    // does not know which build is running and must report no wrapper at all.
    const reporter = makeReporter(() =>
      Promise.reject(new Error("in-band version handshake failed")),
    );
    await expect(reporter.getCapabilities()).rejects.toThrow("in-band version handshake failed");
  });
});

describe("refreshDeclaration() — the emission seam (CP-005-5)", () => {
  it("hands the sink a fresh reading keyed to this driver", async () => {
    const sink = new RecordingDeclarationSink();
    const reporter = makeReporter();

    const verdict = await reporter.refreshDeclaration(sink, {
      sessionId: "session-1",
      nodeId: "node-1",
    });

    expect(sink.calls.length).toBe(1);
    const [call] = sink.calls;
    expect(call?.driverName).toBe(CLAUDE_DRIVER_NAME);
    expect(call?.sessionId).toBe("session-1");
    expect(call?.nodeId).toBe("node-1");
    expect(call?.result).toStrictEqual(await reporter.getCapabilities());
    expect(verdict).toStrictEqual({ emitted: "declared", cliVersionRefreshed: true });
  });

  it("omits `actor` entirely when the caller supplies none", async () => {
    const sink = new RecordingDeclarationSink();
    await makeReporter().refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });
    expect(Object.hasOwn(sink.calls[0] ?? {}, "actor")).toBe(false);
  });

  it("passes an explicit actor through, including an explicit null", async () => {
    const sink = new RecordingDeclarationSink();
    const reporter = makeReporter();
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n", actor: "operator-1" });
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n", actor: null });
    expect(sink.calls[0]?.actor).toBe("operator-1");
    expect(sink.calls[1]?.actor).toBeNull();
  });

  it("returns the sink's verdict unaltered — change detection is the writer's", async () => {
    for (const emitted of ["declared", "updated", "noop"] as const) {
      const sink = new RecordingDeclarationSink({ emitted, cliVersionRefreshed: false });
      const verdict = await makeReporter().refreshDeclaration(sink, {
        sessionId: "s",
        nodeId: "n",
      });
      expect(verdict).toStrictEqual({ emitted, cliVersionRefreshed: false });
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

    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });

    expect(sink.calls[0]?.result.cliVersion.semver).toBe("2.1.245");
    expect(sink.calls[1]?.result.cliVersion.semver).toBe("2.1.246");
  });

  it("does not swallow a sink failure", async () => {
    const failing: DriverCapabilityDeclarationSink = {
      declare: () => Promise.reject(new Error("write seam rejected the declaration")),
    };
    await expect(
      makeReporter().refreshDeclaration(failing, { sessionId: "s", nodeId: "n" }),
    ).rejects.toThrow("write seam rejected the declaration");
  });
});

describe("Claude CLI-version floor (T3.12, P0-2)", () => {
  it("refuses a below-floor reading fail-closed before any report reaches a caller", async () => {
    // 2.1.198 is the PRE-amendment floor — exactly the build the 2026-08-26
    // raise (2.1.198 → 2.1.234) exists to refuse.
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
    await expect(
      reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" }),
    ).rejects.toBeInstanceOf(DriverCliVersionBelowFloorError);
    expect(sink.calls).toHaveLength(0);
  });

  it("refuses a non-canonical reading fail-closed as unparseable", async () => {
    // Reachable only through an untyped boundary (the report shape requires a
    // canonical semver) — the gate still answers typed rather than throwing raw.
    const reporter = makeReporter(() =>
      Promise.resolve({ raw: "Claude Code (unknown)", semver: "unknown" }),
    );
    await expect(reporter.getCapabilities()).rejects.toBeInstanceOf(
      DriverCliVersionUnparseableError,
    );
  });
});

describe("Claude composition is bound to the spawned build (T3.23, I-005-10)", () => {
  it("takes a reading of the spawned build rather than a bare report", async () => {
    // `Spec-005 §Required Behavior`: the version a driver reports is the version
    // that spawned. The reader hands back a reading naming the resolved build,
    // and that reading's report is what the wrapper carries.
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
    // A wiring fault, not provider misbehaviour — an internal-invariant Error
    // rather than a typed provider refusal, and the sink never sees a call.
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
    await expect(
      reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" }),
    ).rejects.toThrow(/driver 'codex'/);
    expect(sink.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// T3.12 C-8 — the current model catalog + per-model effort vocabularies
// --------------------------------------------------------------------------

/**
 * GOLDEN VECTOR — the verbatim `list_models` control-response payload.
 *
 *   Pin        : Claude Code 2.1.251
 *   Provenance : Binary probe, 2026-08-30, one zero-turn control request
 *                `{"subtype":"list_models"}` over `-p --input-format
 *                stream-json`. Copied field-for-field from the reply.
 *   Trust      : Verified at 2.1.251.
 *
 * Keyed on real provider bytes rather than a hand-made shape, so the two rules
 * the wire forces — the `default` pointer colliding with `opus[1m]` on one
 * `resolvedModel`, and the Haiku row publishing no effort surface at all — are
 * exercised against the thing that actually produced them.
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
    // No `supportsEffort` and no `supportedEffortLevels` — the live instance of
    // the contract's "absent = the model exposes no effort selection" reading.
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers",
    },
  ],
});

describe("Claude model catalog (T3.12 C-8)", () => {
  it("reads the recorded reply into four models keyed by resolvedModel", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    // FIVE wire rows, FOUR models: `default` and `opus[1m]` resolve to one.
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5[1m]",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    // The alias `value`s never become ids. `Spec-016 §Same-Agent Provider
    // Switch` validates a switch's model against this list, so admitting
    // `sonnet` or `default` here is a switch target that can move underneath
    // the participant who chose it.
    for (const aliasValue of ["default", "opus[1m]", "sonnet", "haiku"]) {
      expect(models.map((model) => model.id)).not.toContain(aliasValue);
    }
  });

  it("keeps the naming row over the reserved default pointer", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);
    const opus = models.find((model) => model.id === "claude-opus-5[1m]");

    // Not "Default (recommended)": that names the CURRENT default rather than
    // naming this model, so it would re-label whichever model the vendor
    // promotes next.
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

    // The pinned build happens to send the pointer first; a rule that only
    // worked in that order would be an accident of the vendor's ordering.
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Opus (1M context)");
  });

  it("keeps the pointer row when it is a model's only row", () => {
    const pointerOnly = {
      models: [(CLAUDE_RECORDED_LIST_MODELS_REPLY["models"] as Record<string, unknown>[])[0]],
    };

    const models = normalizeClaudeModelCatalog(pointerOnly);

    // Dropping it would lose the model entirely, which is worse than carrying
    // the pointer's own display name.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("claude-opus-5[1m]");
  });

  it("carries each model's published effort levels verbatim", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);

    for (const modelId of ["claude-opus-5[1m]", "claude-fable-5", "claude-sonnet-5"]) {
      const model = models.find((candidate) => candidate.id === modelId);
      // `xhigh` included: the level is read from the build, not restated from a
      // vocabulary this file could get wrong.
      expect(model?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("leaves effortLevels ABSENT for a model with no effort surface", () => {
    const models = normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY);
    const haiku = models.find((model) => model.id === "claude-haiku-4-5-20251001");

    // Absent, not empty: the contract reads absence as "no effort selection",
    // and an empty array would instead assert an axis with nothing on it.
    expect(haiku).toBeDefined();
    expect(haiku && "effortLevels" in haiku).toBe(false);
    expect(haiku?.effortLevels).toBeUndefined();
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

    // The member carries no registered vocabulary anywhere in the corpus and is
    // read by nothing; populating it from the row's `supportsAdaptiveThinking` /
    // `supportsFastMode` / `supportsAutoMode` axes would mint a tag set ahead of
    // its reader.
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
  ])("refuses %s", (_label, payload, message) => {
    // Strict rather than tolerant: a reader that skipped the bad row would
    // answer a short catalog, and nothing downstream could tell a provider that
    // dropped a model from a parser that failed to see one.
    expect(() => normalizeClaudeModelCatalog(payload)).toThrow(ClaudeModelCatalogUnreadableError);
    expect(() => normalizeClaudeModelCatalog(payload)).toThrow(message);
  });

  it("answers the declared catalog when no exchange is bound", async () => {
    const models = await resolveClaudeModelCatalog(null);

    expect(models.map((model) => model.id)).toEqual(
      CLAUDE_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
    // The declaration and the recorded reply are the same reading, so a drift
    // between them is a failing test rather than a silently stale catalog.
    expect(models).toEqual(normalizeClaudeModelCatalog(CLAUDE_RECORDED_LIST_MODELS_REPLY));
  });

  it("hands out fresh copies of the declared catalog", async () => {
    const first = await resolveClaudeModelCatalog(null);
    first[0]?.capabilities.push("mutated");
    first[0]?.effortLevels?.push("mutated");

    const second = await resolveClaudeModelCatalog(null);

    // The constant is frozen and shared process-wide, but `ProviderModel`
    // carries mutable arrays — a caller rewriting one must not rewrite every
    // later caller's answer.
    expect(second[0]?.capabilities).toEqual([]);
    expect(second[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("prefers a bound exchange over the declaration", async () => {
    const models = await resolveClaudeModelCatalog(async () => ({
      models: [{ value: "z", resolvedModel: "model-z", displayName: "Z" }],
    }));

    expect(models).toEqual([{ id: "model-z", name: "Z", capabilities: [] }]);
  });

  it("never falls back to the declaration when a bound exchange fails", async () => {
    const transportFailure = new Error("channel closed");

    // Serving a stale catalog under the appearance of a live read is the one
    // confusion the detection-source doctrine exists to prevent.
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

// Codex capability declaration and refresh seam.
//
// Covers:
//   * the driver declares its capability flags; the runtime treats an undeclared one as
//     unsupported.
//   * the Codex column, restated independently below, so a typo in the module fails a test instead
//     of silently changing the matrix.
//   * the flags record is total over the canonical flag set, checked by a type-level exactness
//     assertion, a runtime key-set compare, and the production write-seam guard
//     `assertValidCapabilityFlags`.
//   * the refresh trigger declares through the writer and surfaces its change-detected verdict
//     unchanged, with no local change detection.

import { DRIVER_CAPABILITY_FLAGS, ProviderToolMetadataSchema } from "@ai-sidekicks/contracts";
import type {
  DriverCapabilityFlag,
  DriverCliVersionReport,
  GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
  fullyProbedDetectionReading,
} from "../../../__fixtures__/capability-probe-doubles.js";
import type { CapabilityDetectionReading } from "../../../capability-probe.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../../../capability-refresh.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import { DRIVER_OUTPUT_SPEED_LEVELS } from "../../../driver-output-speed.js";
import {
  assertValidCapabilityFlags,
  assertValidCliVersionReport,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
} from "../../../provider-output-validation.js";
import type { SpawnedProviderVersionReading } from "../../../version-gate.js";
import {
  CODEX_CAPABILITY_CONTRACT_VERSION,
  CODEX_CAPABILITY_FLAGS,
  CODEX_DECLARED_MODEL_CATALOG,
  CODEX_DRIVER_NAME,
  CODEX_OUTPUT_SPEED_LEVELS,
  CodexModelCatalogUnreadableError,
  getCodexCapabilities,
  normalizeCodexModelCatalog,
  refreshCodexCapabilities,
  resolveCodexModelCatalog,
} from "../capabilities.js";
import { CODEX_TOOL_METADATA } from "../tools.js";

// The Codex column, restated here instead of imported from the module under test, so the
// assertion is not a tautology.
const SPEC_CODEX_MATRIX: Record<DriverCapabilityFlag, boolean> = {
  resume: true,
  steer: true,
  interactive_requests: true,
  mcp: true,
  tool_calls: true,
  reasoning_stream: false,
  model_mutation: true,
  structured_output: true,
  rollback: true,
  session_goals: true,
  callback_tools: true,
  subagents: true,
  transcript_replay: true,
  // `context_compaction` and `provider_commands` are native on this provider
  // (`thread/compact/start` and `skills/list`). `output_speed` is false because the CLI declares
  // neither a settable level vocabulary nor a declared-state read, and nothing is emulated onto
  // it, although the wire does carry a per-turn `serviceTier` override.
  context_compaction: true,
  provider_commands: true,
  output_speed: false,
};

const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "0.149.1",
  semver: "0.149.1",
};

// A Cellar path, deliberately not the `/opt/homebrew/bin/codex` launcher symlink: a reading carries
// the dereferenced build.
const RESOLVED_CODEX_EXECUTABLE = "/opt/homebrew/Cellar/codex/0.149.1/bin/codex";

/**
 * An in-band reading of a spawned Codex build. Composition takes a reading, not a bare report, so
 * a declaration cannot be composed from a version that did not come from the process this node
 * spawned.
 */
function codexReading(
  report: DriverCliVersionReport = CLI_VERSION_REPORT,
): SpawnedProviderVersionReading {
  return {
    driverName: CODEX_DRIVER_NAME,
    resolvedExecutablePath: RESOLVED_CODEX_EXECUTABLE,
    report,
  };
}

const CLI_VERSION_READING: SpawnedProviderVersionReading = codexReading();

// Composition takes a detection reading beside the version reading, so a matrix-only declaration is
// unrepresentable. These two carry the happy path; the probe table, classifier, negative control
// and withdrawal paths are exercised in `provider/__tests__/capability-probe.test.ts`.
const CODEX_DETECTION: CapabilityDetectionReading = fullyProbedDetectionReading(
  "codex",
  CLI_VERSION_READING.resolvedExecutablePath,
);
const CODEX_PROBE = new RecordingCapabilityProbeTransport("codex");

/** The diagnostic band, muted: this suite asserts declarations, not records. */
function silentDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
}

// Type-level check that the declared key set is exactly the canonical flag union: a missing or
// stray flag fails to compile.
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
const declaredFlagKeysAreExactlyCanonical: MutuallyAssignable<
  keyof typeof CODEX_CAPABILITY_FLAGS,
  DriverCapabilityFlag
> = true;

describe("Codex capability declaration", () => {
  it("declares exactly Codex matrix", () => {
    expect(declaredFlagKeysAreExactlyCanonical).toBe(true);
    expect({ ...CODEX_CAPABILITY_FLAGS }).toEqual(SPEC_CODEX_MATRIX);
  });

  it("answers EVERY canonical capability flag (totality)", () => {
    const declaredKeys = Object.keys(CODEX_CAPABILITY_FLAGS).sort();
    expect(declaredKeys).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(typeof CODEX_CAPABILITY_FLAGS[flag]).toBe("boolean");
    }
  });

  it("passes the production write-seam flag guard", () => {
    // `DriverCapabilitiesWriter.declare` runs this guard before opening its transaction; it rejects
    // extras and omissions, which a hand-rolled key compare alone would not prove.
    expect(() => {
      assertValidCapabilityFlags(
        getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION).capabilities.flags,
      );
    }).not.toThrow();
  });

  it("declares transcript_replay TRUE now that the replay leg reads it", () => {
    // The flag flips together with the replay leg in `../lifecycle.ts`, which seeds the transcript
    // through `thread/inject_items` and refuses any answer inconsistent with the transcript's tail.
    expect(Object.hasOwn(CODEX_CAPABILITY_FLAGS, "transcript_replay")).toBe(true);
    expect(CODEX_CAPABILITY_FLAGS.transcript_replay).toBe(true);
  });

  it("declares reasoning_stream FALSE (the fail-closed row)", () => {
    // Separate from the matrix compare because this false row is load-bearing downstream: the
    // reasoning surface renders unavailable.
    expect(CODEX_CAPABILITY_FLAGS.reasoning_stream).toBe(false);
  });
});

describe("Codex getCapabilities() wrapper", () => {
  it("returns the V1 GetCapabilitiesResult wrapper shape", () => {
    const result: GetCapabilitiesResult = getCodexCapabilities(
      CLI_VERSION_READING,
      CODEX_DETECTION,
    );
    expect(() => {
      assertValidGetCapabilitiesResultShape(result);
    }).not.toThrow();
    expect(() => {
      assertValidContractVersion(result.capabilities.contractVersion);
    }).not.toThrow();
    expect(() => {
      assertValidCliVersionReport(CODEX_DRIVER_NAME, result.cliVersion);
    }).not.toThrow();
    expect(result.capabilities.contractVersion).toBe(CODEX_CAPABILITY_CONTRACT_VERSION);
  });

  it("spells the shared vocabulary table rather than copying it", () => {
    // Identity, not equality: the durable cache's hydration path serves this same member with no
    // driver in hand, so both paths must read one table.
    expect(CODEX_OUTPUT_SPEED_LEVELS).toBe(DRIVER_OUTPUT_SPEED_LEVELS.codex);
  });

  it("OMITS the speed vocabulary rather than publishing an empty one", () => {
    // `Object.hasOwn`, not `toBeUndefined()`: under `exactOptionalPropertyTypes` the latter passes
    // for a key that is present and holds `undefined`, the regression an edit to the conditional
    // spread would introduce. Omission and an empty array mean the same to the axis's reader, but
    // omission is what a driver with no such axis should say.
    const result: GetCapabilitiesResult = getCodexCapabilities(
      CLI_VERSION_READING,
      CODEX_DETECTION,
    );

    expect(CODEX_CAPABILITY_FLAGS.output_speed).toBe(false);
    expect(Object.hasOwn(result, "outputSpeedLevels")).toBe(false);
  });

  it("carries tool census, and every row passes the write-seam schema", () => {
    const result = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(result.tools).toEqual([...CODEX_TOOL_METADATA]);
    for (const tool of result.tools) {
      expect(ProviderToolMetadataSchema.safeParse(tool).success).toBe(true);
    }
  });

  it("threads cliVersion through VERBATIM without parsing or normalizing it", () => {
    // The version is passed through untouched: the floor gate refuses an inadmissible report but
    // never rewrites an admissible one.
    const oddReport: DriverCliVersionReport = {
      raw: "codex-cli 0.149.1 (build abc123)",
      semver: "0.149.1",
    };
    const result = getCodexCapabilities(codexReading(oddReport), CODEX_DETECTION);
    expect(result.cliVersion).toEqual(oddReport);
    // Copied, not aliased: a caller mutating the report must not change a declaration already
    // handed to the writer.
    expect(result.cliVersion).not.toBe(oddReport);
  });

  it("hands out fresh objects so one caller cannot corrupt a later declaration", () => {
    const first = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    const second = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(first).toEqual(second);
    expect(first.capabilities.flags).not.toBe(second.capabilities.flags);
    expect(first.tools).not.toBe(second.tools);

    first.capabilities.flags.reasoning_stream = true;
    first.tools.pop();
    const third = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(third.capabilities.flags.reasoning_stream).toBe(false);
    expect(third.tools).toEqual([...CODEX_TOOL_METADATA]);
    expect(CODEX_CAPABILITY_FLAGS.reasoning_stream).toBe(false);
  });
});

describe("Codex capability refresh seam", () => {
  it("declares through writer with the Codex driver key and composed report", async () => {
    const sink = new RecordingDeclarationSink({
      snapshotChange: "created",
      cliVersionRefreshed: true,
    });
    const verdict = await refreshCodexCapabilities(sink, {
      reading: CLI_VERSION_READING,
      probe: CODEX_PROBE.exchange,
      diagnostics: silentDiagnostics(),
    });

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(call.driverName).toBe(CODEX_DRIVER_NAME);
    expect(call.driverName).toBe("codex");
    expect(call.result).toEqual(getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION));
    // The writer owns change detection; this seam surfaces its verdict as is.
    expect(verdict).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });
  });

  it("returns an unchanged verdict as-is (no local change detection)", async () => {
    // The seam neither suppresses nor invents the writer's verdict, so "did it change?" has one
    // answer.
    const sink = new RecordingDeclarationSink({
      snapshotChange: "unchanged",
      cliVersionRefreshed: false,
    });
    const verdict = await refreshCodexCapabilities(sink, {
      reading: CLI_VERSION_READING,
      probe: CODEX_PROBE.exchange,
      diagnostics: silentDiagnostics(),
    });
    expect(verdict.snapshotChange).toBe("unchanged");
    expect(sink.calls).toHaveLength(1);
  });
});

describe("Codex CLI-version floor", () => {
  it("refuses a below-floor report at composition, so attach and refresh both hit the gate", () => {
    let thrown: unknown;
    try {
      getCodexCapabilities(
        codexReading({ raw: "codex-cli 0.140.0", semver: "0.140.0" }),
        CODEX_DETECTION,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverCliVersionBelowFloorError);
    const error = thrown as DriverCliVersionBelowFloorError;
    expect(error.code).toBe("driver.cli_version_below_floor");
    expect(error.fields).toStrictEqual({
      driverName: "codex",
      reportedSemver: "0.140.0",
      floor: DRIVER_CLI_VERSION_FLOORS.codex,
    });
  });

  it("admits the ratified floor itself and any newer build (above the pin included)", () => {
    expect(() => {
      getCodexCapabilities(
        codexReading({ raw: "codex-cli 0.141.0", semver: "0.141.0" }),
        CODEX_DETECTION,
      );
    }).not.toThrow();
    expect(() => {
      getCodexCapabilities(
        codexReading({ raw: "codex-cli 0.150.1", semver: "0.150.1" }),
        CODEX_DETECTION,
      );
    }).not.toThrow();
  });

  it("refuses a non-canonical semver member fail-closed as unparseable", () => {
    expect(() => {
      getCodexCapabilities(
        codexReading({ raw: "codex-cli mystery", semver: "mystery" }),
        CODEX_DETECTION,
      );
    }).toThrow(DriverCliVersionUnparseableError);
  });

  it("refuses the refresh path through the same gate (one comparison, two moments)", async () => {
    const sink = new RecordingDeclarationSink({
      snapshotChange: "unchanged",
      cliVersionRefreshed: false,
    });
    await expect(
      refreshCodexCapabilities(sink, {
        reading: codexReading({ raw: "codex-cli 0.140.0", semver: "0.140.0" }),
        probe: CODEX_PROBE.exchange,
        diagnostics: silentDiagnostics(),
      }),
    ).rejects.toBeInstanceOf(DriverCliVersionBelowFloorError);
    // Fail-closed: the writer never saw the below-floor declaration.
    expect(sink.calls).toHaveLength(0);
  });
});

describe("Codex composition is bound to the spawned build", () => {
  it("threads the SPAWNED reading's report, not a caller-chosen version", () => {
    // The wrapper carries exactly the version the resolved build reported.
    const reading = codexReading({ raw: "0.150.1", semver: "0.150.1" });
    const result = getCodexCapabilities(reading, CODEX_DETECTION);
    expect(result.cliVersion).toStrictEqual({ raw: "0.150.1", semver: "0.150.1" });
    expect(result.cliVersion).not.toBe(reading.report);
  });

  it("refuses a reading taken from ANOTHER driver's build", async () => {
    // A wiring fault, not provider misbehavior: composing Codex flags against a Claude build's
    // version would declare capabilities for a binary this driver did not spawn. It refuses as an
    // internal-invariant Error, not a typed provider refusal.
    const foreign: SpawnedProviderVersionReading = {
      driverName: "claude",
      resolvedExecutablePath: "/opt/homebrew/Cellar/claude/2.1.245/bin/claude",
      report: { raw: "2.1.245", semver: "2.1.245" },
    };
    expect(() => getCodexCapabilities(foreign, CODEX_DETECTION)).toThrow(/driver 'claude'/);

    const sink = new RecordingDeclarationSink({
      snapshotChange: "unchanged",
      cliVersionRefreshed: false,
    });
    await expect(
      refreshCodexCapabilities(sink, {
        reading: foreign,
        probe: CODEX_PROBE.exchange,
        diagnostics: silentDiagnostics(),
      }),
    ).rejects.toThrow(/driver 'claude'/);
    expect(sink.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// The model catalog and per-model effort vocabularies
// --------------------------------------------------------------------------

/**
 * Golden vector: the `model/list` result payload recorded from `codex-cli 0.150.1` with a
 * zero-turn JSON-RPC request to `codex app-server` after `initialize` / `initialized`. Copied
 * field for field, except the per-effort `description` strings, which nothing reads. The recorded
 * reply carried no `serviceTiers`; each row here carries the one tier that later `model/list`
 * reads gave every listed model.
 *
 * Eight rows, `nextCursor: null`, `hidden: false` throughout, and two effort vocabularies, which
 * is why the level list is a per-model member rather than a per-provider constant.
 */
const CODEX_RECORDED_MODEL_LIST_REPLY: Readonly<Record<string, unknown>> = Object.freeze({
  data: [
    codexRecordedModel("gpt-5.6-sol", "GPT-5.6-Sol", true, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    codexRecordedModel("gpt-5.6-terra", "GPT-5.6-Terra", false, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    codexRecordedModel("gpt-5.6-luna", "GPT-5.6-Luna", false, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    codexRecordedModel("gpt-daybreak-blue-latest", "Daybreak Blue", false, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    codexRecordedModel("gpt-5.5", "GPT-5.5", false, ["low", "medium", "high", "xhigh"]),
    codexRecordedModel("gpt-5.4", "GPT-5.4", false, ["low", "medium", "high", "xhigh"]),
    codexRecordedModel("gpt-5.4-mini", "GPT-5.4-Mini", false, ["low", "medium", "high", "xhigh"]),
    codexRecordedModel("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", false, [
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
  ],
  nextCursor: null,
});

/** One recorded row, in the reply's own shape (levels ride nested objects). */
function codexRecordedModel(
  id: string,
  displayName: string,
  isDefault: boolean,
  efforts: readonly string[],
): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName,
    hidden: false,
    isDefault,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: efforts[0],
    inputModalities: ["text"],
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
  };
}

describe("Codex model catalog", () => {
  it("reads the recorded reply into the provider's own eight models, in order", () => {
    const models = normalizeCodexModelCatalog(CODEX_RECORDED_MODEL_LIST_REPLY);

    // The provider lists its recommended model first; re-ordering would silently re-rank what a
    // client renders.
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(models.map((model) => model.name)).toContain("GPT-5.3-Codex-Spark");
  });

  it("carries two DIFFERENT effort vocabularies across the catalog", () => {
    const models = normalizeCodexModelCatalog(CODEX_RECORDED_MODEL_LIST_REPLY);
    const levelsFor = (id: string): string[] | undefined =>
      models.find((model) => model.id === id)?.effortLevels;

    // This spread is why the contract carries the list per model: one provider-wide vocabulary
    // cannot describe these rows.
    expect(levelsFor("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(levelsFor("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(levelsFor("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("leaves effortLevels ABSENT for a row that publishes none", () => {
    const models = normalizeCodexModelCatalog({
      data: [{ id: "model-x", displayName: "X" }],
      nextCursor: null,
    });

    expect(models[0] && "effortLevels" in models[0]).toBe(false);
  });

  it.each([
    ["an explicit null", null],
    ["an empty array", []],
  ])("reads %s effort surface as ABSENT rather than refusing", (_label, rawEfforts) => {
    // Over-strictness control for the unreadable-effort refusal. Both shapes state that the model
    // exposes no effort selection, and refusing either would drop the whole catalog, because the
    // normalizer throws for the entire reply on any entry fault.
    const models = normalizeCodexModelCatalog({
      data: [{ id: "model-x", displayName: "X", supportedReasoningEfforts: rawEfforts }],
      nextCursor: null,
    });

    expect(models.map((model) => model.id)).toEqual(["model-x"]);
    expect(models[0] && "effortLevels" in models[0]).toBe(false);
  });

  it.each([
    ["a tier list", [{ id: "priority", name: "Fast", description: "1.5x speed" }], true],
    ["an empty tier list", [], false],
    ["a null tier list", null, false],
    ["no tier list", undefined, false],
  ])("reads %s as fast %s", (_label, serviceTiers, fast) => {
    const models = normalizeCodexModelCatalog({
      data: [{ id: "model-x", displayName: "X", serviceTiers }],
      nextCursor: null,
    });

    expect(models[0]?.fast).toBe(fast);
  });

  it("drops hidden models", () => {
    const models = normalizeCodexModelCatalog({
      data: [
        { id: "shown", displayName: "Shown" },
        { id: "concealed", displayName: "Concealed", hidden: true },
      ],
      nextCursor: null,
    });

    // The provider declines to offer a hidden model for selection, so publishing it would offer a
    // model its own surface does not.
    expect(models.map((model) => model.id)).toEqual(["shown"]);
  });

  it("populates no capabilities tags", () => {
    const models = normalizeCodexModelCatalog(CODEX_RECORDED_MODEL_LIST_REPLY);

    for (const model of models) {
      expect(model.capabilities).toEqual([]);
    }
  });

  it.each([
    ["a non-object reply", 42, /not an object/],
    ["a reply with no data array", { data: {}, nextCursor: null }, /no `data` array/],
    [
      "a paginated reply",
      { data: [{ id: "a", displayName: "A" }], nextCursor: "page-2" },
      /paginated/,
    ],
    ["a non-object entry", { data: ["gpt-5.5"], nextCursor: null }, /entry is not an object/],
    ["an entry with no id", { data: [{ displayName: "A" }], nextCursor: null }, /no `id`/],
    [
      "an entry with no displayName",
      { data: [{ id: "model-x" }], nextCursor: null },
      /no `displayName`/,
    ],
    [
      "a duplicate id",
      {
        data: [
          { id: "model-x", displayName: "A" },
          { id: "model-x", displayName: "B" },
        ],
        nextCursor: null,
      },
      /appears twice/,
    ],
    [
      "an unreadable effort entry",
      {
        data: [{ id: "model-x", displayName: "A", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
      },
      /unreadable reasoning-effort entry/,
    ],
    [
      "a PRESENT but non-array effort surface",
      {
        data: [{ id: "model-x", displayName: "A", supportedReasoningEfforts: "low,medium" }],
        nextCursor: null,
      },
      /unreadable `supportedReasoningEfforts`/,
    ],
    [
      "an OBJECT effort surface",
      {
        data: [{ id: "model-x", displayName: "A", supportedReasoningEfforts: { low: true } }],
        nextCursor: null,
      },
      /unreadable `supportedReasoningEfforts`/,
    ],
    [
      "a PRESENT but non-array tier list",
      {
        data: [{ id: "model-x", displayName: "A", serviceTiers: "priority" }],
        nextCursor: null,
      },
      /unreadable `serviceTiers`/,
    ],
  ])("refuses %s", (_label, payload, message) => {
    expect(() => normalizeCodexModelCatalog(payload)).toThrow(CodexModelCatalogUnreadableError);
    expect(() => normalizeCodexModelCatalog(payload)).toThrow(message);
  });

  it("refuses a paginated reply BEFORE answering its first page", () => {
    // A first page that parses perfectly but is short would drop models with nothing recording it.
    expect(() =>
      normalizeCodexModelCatalog({
        data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }],
        nextCursor: "cursor-2",
      }),
    ).toThrow(CodexModelCatalogUnreadableError);
  });

  it("answers the declared catalog when no exchange is bound", async () => {
    const models = await resolveCodexModelCatalog(null);

    // A drift between the declaration and the recorded reply fails here instead of leaving a stale
    // catalog.
    expect(models).toEqual(normalizeCodexModelCatalog(CODEX_RECORDED_MODEL_LIST_REPLY));
    expect(models.map((model) => model.id)).toEqual(
      CODEX_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
  });

  it("refuses an in-place mutation of the shared declared catalog", () => {
    // `Object.freeze` on the entry is shallow: it blocks `entry.effortLevels = […]` but not
    // `entry.effortLevels.push(…)`. This constant is re-exported from the driver barrel and
    // shared process-wide, so an unfrozen array would let one consumer rewrite it for all.
    const declaredEntry = CODEX_DECLARED_MODEL_CATALOG[0];
    if (declaredEntry === undefined) {
      throw new Error("the declared catalog is empty");
    }

    expect(Object.isFrozen(declaredEntry)).toBe(true);
    expect(Object.isFrozen(declaredEntry.capabilities)).toBe(true);
    expect(Object.isFrozen(declaredEntry.effortLevels)).toBe(true);
    expect(Object.isFrozen(CODEX_DECLARED_MODEL_CATALOG)).toBe(true);
    // Modules here run in strict mode, so a write throws and the freeze is observable.
    expect(() => declaredEntry.effortLevels?.push("mutated")).toThrow(TypeError);
    expect(() => declaredEntry.capabilities.push("mutated")).toThrow(TypeError);

    expect(declaredEntry.capabilities).toStrictEqual([]);
    expect(declaredEntry.effortLevels).toStrictEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("hands out fresh copies of the declared catalog", async () => {
    const first = await resolveCodexModelCatalog(null);
    first[0]?.capabilities.push("mutated");
    first[0]?.effortLevels?.push("mutated");

    const second = await resolveCodexModelCatalog(null);

    expect(second[0]?.capabilities).toEqual([]);
    expect(second[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("prefers a bound exchange over the declaration", async () => {
    const models = await resolveCodexModelCatalog(async () => ({
      data: [{ id: "model-z", displayName: "Z" }],
      nextCursor: null,
    }));

    expect(models).toEqual([{ id: "model-z", name: "Z", capabilities: [], fast: false }]);
  });

  it("never falls back to the declaration when a bound exchange fails", async () => {
    const transportFailure = new Error("connection closed");

    await expect(
      resolveCodexModelCatalog(async () => {
        throw transportFailure;
      }),
    ).rejects.toBe(transportFailure);
    await expect(resolveCodexModelCatalog(async () => ({ data: [] }))).resolves.toEqual([]);
  });
});

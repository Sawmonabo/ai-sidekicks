// Codex capability declaration: the flags match the provider's matrix, composition admits the floor
// and newer builds but refuses a below-floor, unparseable or foreign reading, and the model catalog
// reads the provider's recorded `model/list` reply.

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
  fullyProbedDetectionReading,
} from "../../../__fixtures__/capability-probe-doubles.js";
import type { CapabilityDetectionReading } from "../../../capability-probe.js";
import {
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../../../capability-refresh.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type { SpawnedProviderVersionReading } from "../../../version-gate.js";
import { CODEX_DRIVER_DESCRIPTOR } from "../codex-driver-descriptor.js";
import {
  CODEX_CAPABILITY_FLAGS,
  CODEX_DRIVER_NAME,
  CodexModelCatalogUnreadableError,
  getCodexCapabilities,
  normalizeCodexModelCatalog,
  refreshCodexCapabilities,
} from "../capabilities.js";
import type { DriverCliVersionReport } from "../../../provider-driver.js";

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
  session_fork: true,
  session_goals: true,
  callback_tools: true,
  subagents: true,
  // `context_compaction` and `provider_commands` are native on this provider
  // (`thread/compact/start` and `skills/list`).
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
// unrepresentable; these two are a fully probed build.
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
  it("declares exactly the Codex capability matrix", () => {
    expect(declaredFlagKeysAreExactlyCanonical).toBe(true);
    expect({ ...CODEX_CAPABILITY_FLAGS }).toEqual(SPEC_CODEX_MATRIX);
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
      floor: CODEX_DRIVER_DESCRIPTOR.cliVersionFloor,
    });
  });

  it("refuses a non-canonical semver member fail-closed as unparseable", () => {
    expect(() => {
      getCodexCapabilities(
        codexReading({ raw: "codex-cli mystery", semver: "mystery" }),
        CODEX_DETECTION,
      );
    }).toThrow(DriverCliVersionUnparseableError);
  });

  it("admits the floor itself and any newer build, above the pin included", () => {
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
});

describe("Codex composition is bound to the spawned build", () => {
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

  it("threads the SPAWNED reading's report, not a caller-chosen version", () => {
    // The wrapper carries exactly the version the resolved build reported.
    const reading = codexReading({ raw: "0.150.1", semver: "0.150.1" });
    const result = getCodexCapabilities(reading, CODEX_DETECTION);
    expect(result.cliVersion).toStrictEqual({ raw: "0.150.1", semver: "0.150.1" });
    expect(result.cliVersion).not.toBe(reading.report);
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
  it("reads the recorded reply into eight models, in order, each with its own effort levels", () => {
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

    const levelsFor = (id: string): string[] | undefined =>
      models.find((model) => model.id === id)?.effortLevels;

    // This spread is why the contract carries the list per model: one provider-wide vocabulary
    // cannot describe these rows.
    expect(levelsFor("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(levelsFor("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(levelsFor("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
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
});

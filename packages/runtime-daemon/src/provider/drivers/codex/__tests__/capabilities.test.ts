// Codex capability declaration: composition refuses a foreign reading, and the model catalog
// reads the provider's recorded `model/list` reply.

import { describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  RecordingDeclarationSink,
  fullyProbedDetectionReading,
} from "../../../__fixtures__/capability-probe-doubles.js";
import { codexDefaultProbeReply } from "../__fixtures__/capability-probe-replies.js";
import type { CapabilityDetectionReading } from "../../../capability-probe.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import type { SpawnedProviderVersionReading } from "../../../version-gate.js";
import {
  CODEX_DRIVER_NAME,
  getCodexCapabilities,
  normalizeCodexModelCatalog,
  refreshCodexCapabilities,
} from "../capabilities.js";
import {
  type DriverCliVersionReport,
  ModelCatalogUnreadableError,
} from "../../../provider-driver.js";

const CLI_VERSION_REPORT: DriverCliVersionReport = {
  rawVersion: "0.149.1",
  parsedVersion: "0.149.1",
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
const CODEX_PROBE = new RecordingCapabilityProbeTransport(codexDefaultProbeReply);

/** The diagnostic band, muted: this suite asserts declarations, not records. */
describe("Codex composition is bound to the spawned build", () => {
  it("refuses a reading taken from ANOTHER driver's build", async () => {
    // A wiring fault, not provider misbehavior: composing Codex flags against a Claude build's
    // version would declare capabilities for a binary this driver did not spawn. It refuses as an
    // internal-invariant Error, not a typed provider refusal.
    const foreign: SpawnedProviderVersionReading = {
      driverName: "claude",
      resolvedExecutablePath: "/opt/homebrew/Cellar/claude/2.1.245/bin/claude",
      report: { rawVersion: "2.1.245", parsedVersion: "2.1.245" },
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
        diagnostics: makeSilentDriverDiagnostics(),
      }),
    ).rejects.toThrow(/driver 'claude'/);
    expect(sink.calls).toHaveLength(0);
  });

  it("threads the SPAWNED reading's report, not a caller-chosen version", () => {
    // The wrapper carries exactly the version the resolved build reported.
    const reading = codexReading({ rawVersion: "0.150.1", parsedVersion: "0.150.1" });
    const result = getCodexCapabilities(reading, CODEX_DETECTION);
    expect(result.cliVersion).toStrictEqual({ rawVersion: "0.150.1", parsedVersion: "0.150.1" });
    expect(result.cliVersion).not.toBe(reading.report);
  });
});

// --------------------------------------------------------------------------
// The model catalog and per-model effort vocabularies
// --------------------------------------------------------------------------

/**
 * Golden vector: the `model/list` result payload recorded from `codex-cli 0.160.0` on Oct 2, 2026
 * with a zero-turn JSON-RPC request to `codex app-server` after `initialize` / `initialized`.
 * Copied field for field for the members listed in `codexRecordedModel`; the per-effort
 * `description` strings and the other members of each row, which nothing reads, are left out.
 *
 * Nine rows, `nextCursor: null`, `hidden: false` throughout, and three effort vocabularies, which
 * is why the level list is a per-model member rather than a per-provider constant.
 */
const CODEX_RECORDED_MODEL_LIST_REPLY: Readonly<Record<string, unknown>> = Object.freeze({
  data: [
    codexRecordedModel(
      "gpt-6.1-sol",
      "GPT-6.1-Sol",
      true,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
      "2x speed, increased usage",
    ),
    codexRecordedModel(
      "gpt-6-astra",
      "GPT-6-Astra",
      false,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "medium",
      "2x speed, increased usage",
    ),
    codexRecordedModel(
      "gpt-6-sol",
      "GPT-6-Sol",
      false,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "medium",
      "1.5x speed",
    ),
    codexRecordedModel(
      "gpt-6-luna",
      "GPT-6-Luna",
      false,
      ["low", "medium", "high", "xhigh", "max"],
      "medium",
      "1.5x speed",
    ),
    codexRecordedModel(
      "gpt-5.6-sol",
      "GPT-5.6-Sol",
      false,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
      "1.5x speed, increased usage",
    ),
    codexRecordedModel(
      "gpt-5.6-terra",
      "GPT-5.6-Terra",
      false,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "medium",
      "1.5x speed, increased usage",
    ),
    codexRecordedModel(
      "gpt-5.6-luna",
      "GPT-5.6-Luna",
      false,
      ["low", "medium", "high", "xhigh", "max"],
      "medium",
      "1.5x speed, increased usage",
    ),
    codexRecordedModel(
      "gpt-daybreak-blue-latest",
      "Daybreak Blue",
      false,
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
      null,
    ),
    codexRecordedModel(
      "gpt-5.5",
      "GPT-5.5",
      false,
      ["low", "medium", "high", "xhigh"],
      "medium",
      "1.5x speed, increased usage",
    ),
  ],
  nextCursor: null,
});

/**
 * One recorded row, in the reply's own shape (levels ride nested objects). `fastTierDescription`
 * is the description of the row's one `priority` tier, or `null` for a row listing no tier.
 */
function codexRecordedModel(
  id: string,
  displayName: string,
  isDefault: boolean,
  efforts: readonly string[],
  defaultReasoningEffort: string,
  fastTierDescription: string | null,
): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName,
    hidden: false,
    isDefault,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort,
    inputModalities: ["text", "image"],
    serviceTiers:
      fastTierDescription === null
        ? []
        : [{ id: "priority", name: "Fast", description: fastTierDescription }],
  };
}

describe("Codex model catalog", () => {
  it("reads the recorded reply into nine models, in order, each with its own effort levels", () => {
    const models = normalizeCodexModelCatalog(CODEX_RECORDED_MODEL_LIST_REPLY);

    // The provider lists its recommended model first; re-ordering would silently re-rank what a
    // client renders.
    expect(models.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
    ]);
    expect(models.map((model) => model.name)).toContain("Daybreak Blue");

    const levelsFor = (id: string): string[] | undefined =>
      models.find((model) => model.id === id)?.effortLevels;

    // This spread is why the contract carries the list per model: one provider-wide vocabulary
    // cannot describe these rows.
    expect(levelsFor("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(levelsFor("gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(levelsFor("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("refuses a paginated reply BEFORE answering its first page", () => {
    // A first page that parses perfectly but is short would drop models with nothing recording it.
    expect(() =>
      normalizeCodexModelCatalog({
        data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" }],
        nextCursor: "cursor-2",
      }),
    ).toThrow(ModelCatalogUnreadableError);
  });
});

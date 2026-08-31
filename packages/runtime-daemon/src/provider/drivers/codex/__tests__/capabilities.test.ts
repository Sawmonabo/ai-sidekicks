// T3.3 — Codex capability declaration + refresh seam.
//
// Coverage targets (audit-derived, not just the plan ACs):
//   * `Spec-005 §Required Behavior` — the driver DECLARES its capability
//     flags; the runtime treats an undeclared capability as unsupported.
//   * `Spec-005 §Per-Driver Capability Matrix` — the Codex column, restated
//     independently below so a typo in the module is a failing test rather
//     than a silently wrong matrix.
//   * I-005-2 — the flags record is TOTAL over the canonical flag set. Proven
//     three ways: a type-level exactness assertion, a runtime key-set compare,
//     and the production write-seam guard `assertValidCapabilityFlags`, which
//     is the code that actually decides whether a declaration is admissible.
//   * CP-005-5 — the refresh trigger declares through the T2.4 writer and
//     surfaces its change-detected emission discriminant unchanged. No new
//     event type, no local change detection.

import { DRIVER_CAPABILITY_FLAGS, ProviderToolMetadataSchema } from "@ai-sidekicks/contracts";
import type {
  DriverCapabilityFlag,
  DriverCliVersionReport,
  GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  RecordingCapabilityProbeTransport,
  fullyProbedDetectionReading,
} from "../../../__fixtures__/capability-probe-doubles.js";
import type { CapabilityDetectionReading } from "../../../capability-probe.js";
import {
  DRIVER_CLI_VERSION_FLOORS,
  DriverCliVersionBelowFloorError,
  DriverCliVersionUnparseableError,
} from "../../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
} from "../../../driver-capabilities-writer.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import { DriverCapabilityUnsupportedError, ProviderRegistry } from "../../../provider-registry.js";
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
  CODEX_DRIVER_NAME,
  getCodexCapabilities,
  refreshCodexCapabilities,
} from "../capabilities.js";
import type { DriverCapabilityDeclarationSink } from "../capabilities.js";
import { CODEX_TOOL_METADATA } from "../tools.js";

// `Spec-005 §Per-Driver Capability Matrix`, Codex column — transcribed here
// from the spec rather than imported from the module under test, so this
// assertion is an INDEPENDENT restatement and not a tautology.
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
  transcript_replay: false,
  cost_cap: false,
};

const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "0.149.1",
  semver: "0.149.1",
};

// The build a T3.23 reading names — a Cellar path, deliberately NOT the
// `/opt/homebrew/bin/codex` launcher symlink that points at it, because the
// whole point of the reading is that it carries the dereferenced build.
const RESOLVED_CODEX_EXECUTABLE = "/opt/homebrew/Cellar/codex/0.149.1/bin/codex";

/**
 * A T3.23 in-band reading of a spawned Codex build. Composition takes a READING
 * and not a bare report since T3.23, so a declaration cannot be composed from a
 * version that did not come from the process this node spawned.
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

// T3.24: the composition now takes a detection reading beside the version
// reading, so a matrix-only declaration is unrepresentable. These two carry the
// happy path for the pre-existing assertions below; the probe table, the
// classifier, the negative control, and the withdrawal paths are exercised in
// `provider/__tests__/capability-probe.test.ts`.
const CODEX_DETECTION: CapabilityDetectionReading = fullyProbedDetectionReading(
  "codex",
  CLI_VERSION_READING.resolvedExecutablePath,
);
const CODEX_PROBE = new RecordingCapabilityProbeTransport("codex");

/** The diagnostic band, muted: this suite asserts declarations, not records. */
function silentDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
}

// Type-level half of I-005-2: the declared key set is EXACTLY the canonical
// flag union. A missing flag or a stray one fails to compile — the assignment
// below is the assertion.
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
const declaredFlagKeysAreExactlyCanonical: MutuallyAssignable<
  keyof typeof CODEX_CAPABILITY_FLAGS,
  DriverCapabilityFlag
> = true;

/**
 * A typed fake of the ONE writer method this seam uses. Typing it as
 * `DriverCapabilityDeclarationSink` (a `Pick` of the real class) means a
 * signature change on `DriverCapabilitiesWriter.declare` breaks this file at
 * compile time instead of leaving a stale fake passing.
 */
class RecordingDeclarationSink implements DriverCapabilityDeclarationSink {
  readonly calls: DeclareDriverCapabilitiesInput[] = [];
  #nextResult: DeclareDriverCapabilitiesResult;

  constructor(nextResult: DeclareDriverCapabilitiesResult) {
    this.#nextResult = nextResult;
  }

  declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    this.calls.push(input);
    return Promise.resolve(this.#nextResult);
  }
}

describe("Codex capability declaration (T3.3)", () => {
  it("declares exactly the Spec-005 Codex matrix", () => {
    expect(declaredFlagKeysAreExactlyCanonical).toBe(true);
    expect({ ...CODEX_CAPABILITY_FLAGS }).toEqual(SPEC_CODEX_MATRIX);
  });

  it("answers EVERY canonical capability flag (I-005-2 totality)", () => {
    const declaredKeys = Object.keys(CODEX_CAPABILITY_FLAGS).sort();
    expect(declaredKeys).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(typeof CODEX_CAPABILITY_FLAGS[flag]).toBe("boolean");
    }
  });

  it("passes the production write-seam flag guard", () => {
    // `assertValidCapabilityFlags` is what `DriverCapabilitiesWriter.declare`
    // runs before opening its transaction, and it REJECTS both extras and
    // omissions. Driving the real guard proves the declaration is admissible,
    // which a hand-rolled key compare alone does not.
    expect(() => {
      assertValidCapabilityFlags(
        getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION).capabilities.flags,
      );
    }).not.toThrow();
  });

  it("declares transcript_replay FALSE pending the replay leg", () => {
    // The union now carries the flag, so the module's `Record` totality forces
    // an answer and the only question is which one. `false` is the fail-closed
    // reading until the driver-side replay operation ships and re-probes it —
    // undeclared and declared-unsupported must look the same to a caller.
    expect(Object.hasOwn(CODEX_CAPABILITY_FLAGS, "transcript_replay")).toBe(true);
    expect(CODEX_CAPABILITY_FLAGS.transcript_replay).toBe(false);
  });

  it("declares reasoning_stream and cost_cap FALSE (the two fail-closed rows)", () => {
    // Called out separately from the matrix compare because both `false` rows
    // are load-bearing downstream: the reasoning surface renders unavailable,
    // and Spec-016's native-cap escape refuses reservation on a capless leg.
    expect(CODEX_CAPABILITY_FLAGS.reasoning_stream).toBe(false);
    expect(CODEX_CAPABILITY_FLAGS.cost_cap).toBe(false);
  });
});

describe("Codex getCapabilities() wrapper (T3.3)", () => {
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

  it("carries the T3.4 tool census, and every row passes the write-seam schema", () => {
    const result = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(result.tools).toEqual([...CODEX_TOOL_METADATA]);
    for (const tool of result.tools) {
      expect(ProviderToolMetadataSchema.safeParse(tool).success).toBe(true);
    }
  });

  it("threads cliVersion through VERBATIM without parsing or normalizing it", () => {
    // The version is never invented here; the T3.12 floor gate below REFUSES
    // an inadmissible report but never rewrites an admissible one — a
    // non-canonical raw string must survive untouched.
    const oddReport: DriverCliVersionReport = {
      raw: "codex-cli 0.149.1 (build abc123)",
      semver: "0.149.1",
    };
    const result = getCodexCapabilities(codexReading(oddReport), CODEX_DETECTION);
    expect(result.cliVersion).toEqual(oddReport);
    // Copied, not aliased — a caller mutating the report must not retroactively
    // change a declaration already handed to the writer.
    expect(result.cliVersion).not.toBe(oddReport);
  });

  it("hands out fresh objects so one caller cannot corrupt a later declaration", () => {
    const first = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    const second = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(first).toEqual(second);
    expect(first.capabilities.flags).not.toBe(second.capabilities.flags);
    expect(first.tools).not.toBe(second.tools);

    first.capabilities.flags.cost_cap = true;
    first.tools.pop();
    const third = getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION);
    expect(third.capabilities.flags.cost_cap).toBe(false);
    expect(third.tools).toEqual([...CODEX_TOOL_METADATA]);
    expect(CODEX_CAPABILITY_FLAGS.cost_cap).toBe(false);
  });
});

describe("Codex capability refresh seam (T3.3, CP-005-5)", () => {
  it("declares through the T2.4 writer with the Codex driver key and composed report", async () => {
    const sink = new RecordingDeclarationSink({ emitted: "declared", cliVersionRefreshed: true });
    const emission = await refreshCodexCapabilities(sink, {
      sessionId: "session-1",
      nodeId: "node-1",
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
    expect(call.sessionId).toBe("session-1");
    expect(call.nodeId).toBe("node-1");
    expect(call.result).toEqual(getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION));
    // `actor` absent (not `undefined`) means the writer's system-actor default.
    expect(Object.prototype.hasOwnProperty.call(call, "actor")).toBe(false);
    // The writer owns change detection; this seam surfaces its verdict as-is.
    expect(emission).toEqual({ emitted: "declared", cliVersionRefreshed: true });
  });

  it("threads an explicit actor when the caller supplies one", async () => {
    const sink = new RecordingDeclarationSink({ emitted: "updated", cliVersionRefreshed: false });
    await refreshCodexCapabilities(sink, {
      sessionId: "session-2",
      nodeId: "node-2",
      reading: CLI_VERSION_READING,
      probe: CODEX_PROBE.exchange,
      diagnostics: silentDiagnostics(),
      actor: "participant-7",
    });
    expect(sink.calls[0]?.actor).toBe("participant-7");
  });

  it("threads an EXPLICIT null actor through as null, not as an absent key", async () => {
    // The third arm of the conditional spread. `null` is the writer's system
    // actor, so explicit-null and absent converge behaviorally — but they are
    // distinguishable inputs, and only an explicit test pins which one the
    // caller's `null` becomes.
    const sink = new RecordingDeclarationSink({ emitted: "declared", cliVersionRefreshed: true });
    await refreshCodexCapabilities(sink, {
      sessionId: "session-4",
      nodeId: "node-4",
      reading: CLI_VERSION_READING,
      probe: CODEX_PROBE.exchange,
      diagnostics: silentDiagnostics(),
      actor: null,
    });
    const call = sink.calls[0];
    expect(call).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(call ?? {}, "actor")).toBe(true);
    expect(call?.actor).toBeNull();
  });

  it("returns a noop emission unchanged (no local change detection)", async () => {
    // Re-declaring an unchanged snapshot must append nothing to the timeline.
    // This seam neither suppresses nor manufactures that verdict — it reports
    // the writer's, which is what keeps a single answer to "did it change?".
    const sink = new RecordingDeclarationSink({ emitted: "noop", cliVersionRefreshed: false });
    const emission = await refreshCodexCapabilities(sink, {
      sessionId: "session-3",
      nodeId: "node-3",
      reading: CLI_VERSION_READING,
      probe: CODEX_PROBE.exchange,
      diagnostics: silentDiagnostics(),
    });
    expect(emission.emitted).toBe("noop");
    expect(sink.calls).toHaveLength(1);
  });
});

describe("Codex CLI-version floor (T3.12, P0-2)", () => {
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
    const sink = new RecordingDeclarationSink({ emitted: "noop", cliVersionRefreshed: false });
    await expect(
      refreshCodexCapabilities(sink, {
        sessionId: "session-floor",
        nodeId: "node-floor",
        reading: codexReading({ raw: "codex-cli 0.140.0", semver: "0.140.0" }),
        probe: CODEX_PROBE.exchange,
        diagnostics: silentDiagnostics(),
      }),
    ).rejects.toBeInstanceOf(DriverCliVersionBelowFloorError);
    // Fail-closed means the writer never saw the below-floor declaration.
    expect(sink.calls).toHaveLength(0);
  });
});

describe("Codex cost_cap static refusal (T3.12)", () => {
  it("refuses a cost_cap-gated admission against Codex statically at the registry gate", async () => {
    const registry = new ProviderRegistry();
    // `register` calls exactly one driver operation (`getCapabilities`), and
    // this test feeds it the REAL Codex declaration — so the refusal below is
    // decided by the driver's own declared matrix, statically, with no
    // provider round trip. The cast narrows a one-method object to the
    // contract; any other operation the registry hypothetically called would
    // fail loudly as undefined.
    const declarationOnlyDriver = {
      getCapabilities: () =>
        Promise.resolve(getCodexCapabilities(CLI_VERSION_READING, CODEX_DETECTION)),
    } as unknown as Parameters<ProviderRegistry["register"]>[1];
    await registry.register(CODEX_DRIVER_NAME, declarationOnlyDriver);

    let thrown: unknown;
    try {
      registry.checkCapability(CODEX_DRIVER_NAME, "cost_cap");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriverCapabilityUnsupportedError);
    const error = thrown as DriverCapabilityUnsupportedError;
    expect(error.code).toBe("driver.capability_unsupported");
    expect(error.fields).toStrictEqual({ driverId: "codex", flag: "cost_cap" });

    // Sanity inversion: a flag Codex DOES declare passes the same gate, so the
    // refusal above is the declaration's doing, not the registry's default.
    expect(() => {
      registry.checkCapability(CODEX_DRIVER_NAME, "steer");
    }).not.toThrow();
  });
});

describe("Codex composition is bound to the spawned build (T3.23, I-005-10)", () => {
  it("threads the SPAWNED reading's report, not a caller-chosen version", () => {
    // `Spec-005 §Required Behavior`: "the version a driver reports is the
    // version that spawned". The composition takes the reading, so the wrapper
    // it emits carries exactly the version the resolved build reported.
    const reading = codexReading({ raw: "0.150.1", semver: "0.150.1" });
    const result = getCodexCapabilities(reading, CODEX_DETECTION);
    expect(result.cliVersion).toStrictEqual({ raw: "0.150.1", semver: "0.150.1" });
    expect(result.cliVersion).not.toBe(reading.report);
  });

  it("refuses a reading taken from ANOTHER driver's build", async () => {
    // A wiring fault, not provider misbehaviour: composing Codex's flags against
    // a Claude build's version would declare capabilities for a binary that is
    // not the one this driver spawns. It refuses as an internal-invariant Error
    // rather than as a typed provider refusal.
    const foreign: SpawnedProviderVersionReading = {
      driverName: "claude",
      resolvedExecutablePath: "/opt/homebrew/Cellar/claude/2.1.245/bin/claude",
      report: { raw: "2.1.245", semver: "2.1.245" },
    };
    expect(() => getCodexCapabilities(foreign, CODEX_DETECTION)).toThrow(/driver 'claude'/);

    const sink = new RecordingDeclarationSink({ emitted: "noop", cliVersionRefreshed: false });
    await expect(
      refreshCodexCapabilities(sink, {
        sessionId: "session-foreign",
        nodeId: "node-foreign",
        reading: foreign,
        probe: CODEX_PROBE.exchange,
        diagnostics: silentDiagnostics(),
      }),
    ).rejects.toThrow(/driver 'claude'/);
    expect(sink.calls).toHaveLength(0);
  });
});

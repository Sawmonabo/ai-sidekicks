// Zero-turn capability detection: the detection-mechanism table, the probe transport, the negative
// control, reply classification, per-capability withdrawal and the cadence re-probe.
//
// Probing is asserted at a recording transport double, not at the daemon's event stream: a probe
// that billed before normal event handling attached would emit no cost or run event, so a
// daemon-side assertion could not tell "no turn" from "no listener". Change detection is asserted
// over the real DriverCapabilitiesWriter and a real SQLite handle, because a sink fake would only
// assert its own canned discriminant.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type CapabilityDetectionSource,
  type DriverCapabilityFlag,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  RecordingCapabilityProbeTransport,
  claudeContextualRefusalReply,
  claudeSuccessReply,
  claudeUnsupportedSubtypeReply,
  codexCapabilityGatedReply,
  codexInvalidParamsReply,
  codexMissingFieldReply,
  codexResultReply,
  codexUnknownMethodReply,
  codexUnknownVariantReply,
} from "../__fixtures__/capability-probe-doubles.js";
import {
  CAPABILITY_DETECTION_TABLES,
  CAPABILITY_PROBE_CHANNELS,
  CAPABILITY_PROBE_NEGATIVE_CONTROLS,
  CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES,
  CLAUDE_CAPABILITY_DETECTION_TABLE,
  CODEX_CAPABILITY_DETECTION_TABLE,
  CapabilityProbeError,
  CapabilityProbeNegativeControlError,
  CapabilityProbeProhibitedNameError,
  CapabilityProbeTransportError,
  applyCapabilityDetection,
  assertProbeWireNameAdmissible,
  classifyClaudeProbeReply,
  classifyCodexProbeReply,
  findCapabilityDetectionTableViolations,
  readCapabilityDetection,
  type CapabilityDetectionMechanism,
  type DriverCapabilityDetectionTable,
  type ProbeAdmissibilityConjunct,
} from "../capability-probe.js";
import type { FlooredDriverName } from "../capability-refresh.js";
import { DriverCliVersionBelowFloorError } from "../capability-refresh.js";
import {
  DriverCapabilitiesWriter,
  type DeclareDriverCapabilitiesResult,
} from "../driver-capabilities-writer.js";
import {
  DRIVER_DIAGNOSTIC_COUNTER_NAMES,
  DriverDiagnosticsEmitter,
  InMemoryDriverDiagnosticCounterSink,
} from "../driver-diagnostics.js";
import {
  CLAUDE_CAPABILITY_FLAGS,
  CLAUDE_DRIVER_NAME,
  ClaudeCapabilityReporter,
} from "../drivers/claude/capabilities.js";
import {
  CODEX_CAPABILITY_FLAGS,
  CODEX_DRIVER_NAME,
  getCodexCapabilities,
  readCodexCapabilityDetection,
  refreshCodexCapabilities,
} from "../drivers/codex/capabilities.js";
import type { SpawnedProviderVersionReading } from "../version-gate.js";

const DRIVERS: readonly FlooredDriverName[] = ["claude", "codex"];

/** The closed conjunct set, restated apart from the module's type, which is erased at runtime. */
const SPEC_ADMISSIBILITY_CONJUNCTS: readonly ProbeAdmissibilityConjunct[] = [
  "zero-turn",
  "non-mutating",
  "decisive-at-consumption-granularity",
];

const CLAUDE_VERSION_READING: SpawnedProviderVersionReading = {
  driverName: CLAUDE_DRIVER_NAME,
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  report: { raw: "2.1.251", semver: "2.1.251" },
};

const CODEX_VERSION_READING: SpawnedProviderVersionReading = {
  driverName: CODEX_DRIVER_NAME,
  resolvedExecutablePath: "/opt/homebrew/Cellar/codex/0.150.1/bin/codex",
  report: { raw: "codex-cli 0.150.1", semver: "0.150.1" },
};

const MATRIX_FLAGS: Readonly<
  Record<FlooredDriverName, Readonly<Record<DriverCapabilityFlag, boolean>>>
> = { claude: CLAUDE_CAPABILITY_FLAGS, codex: CODEX_CAPABILITY_FLAGS };

function probedFlagsOf(table: DriverCapabilityDetectionTable): DriverCapabilityFlag[] {
  return (Object.entries(table) as [DriverCapabilityFlag, CapabilityDetectionMechanism][]).flatMap(
    ([flag, mechanism]) => (mechanism.detectionSource === "probed" ? [flag] : []),
  );
}

const VERSION_READINGS: Readonly<Record<FlooredDriverName, SpawnedProviderVersionReading>> = {
  claude: CLAUDE_VERSION_READING,
  codex: CODEX_VERSION_READING,
};

/** The build a driver's detection read is bound to, from its version reading. */
function boundPathFor(driverName: FlooredDriverName): string {
  return VERSION_READINGS[driverName].resolvedExecutablePath;
}

/**
 * The drivers whose table declares a probe, derived so a demotion or promotion cannot make a block
 * fail for the wrong reason. A test pins which drivers are in the set.
 */
const PROBING_DRIVERS: readonly FlooredDriverName[] = DRIVERS.filter(
  (driverName) => probedFlagsOf(CAPABILITY_DETECTION_TABLES[driverName]).length > 0,
);

/**
 * The flag a probing driver's withdrawal assertions run through, named so a table edit cannot
 * silently change which capability is covered. A test pins that it is still probed.
 */
const WITHDRAWAL_CANARY_FLAG: Readonly<Partial<Record<FlooredDriverName, DriverCapabilityFlag>>> = {
  codex: "steer",
};

function withdrawalCanaryFor(driverName: FlooredDriverName): DriverCapabilityFlag {
  const canary = WITHDRAWAL_CANARY_FLAG[driverName];
  if (canary === undefined) {
    throw new Error(`test fixture error: driver '${driverName}' declares no withdrawal canary`);
  }
  return canary;
}

function probeNamesFor(
  table: DriverCapabilityDetectionTable,
  flag: DriverCapabilityFlag,
): readonly string[] {
  const mechanism = table[flag];
  if (mechanism.detectionSource !== "probed") {
    throw new Error(`test fixture error: '${flag}' is not a probed entry`);
  }
  return mechanism.probe.probeNames;
}

/** The first name of a probed flag — the one a single-name assertion means. */
function firstProbeNameFor(
  table: DriverCapabilityDetectionTable,
  flag: DriverCapabilityFlag,
): string {
  const [firstName] = probeNamesFor(table, flag);
  if (firstName === undefined) {
    throw new Error(`test fixture error: '${flag}' declares no probe names`);
  }
  return firstName;
}

/**
 * An emitter over a silent log sink and a counting metrics sink, so both the record and the
 * counter can be asserted.
 */
function recordingDiagnostics(): {
  readonly emitter: DriverDiagnosticsEmitter;
  readonly counters: InMemoryDriverDiagnosticCounterSink;
} {
  const counters = new InMemoryDriverDiagnosticCounterSink();
  const emitter = new DriverDiagnosticsEmitter({
    logSink: { record: () => undefined },
    counterSink: counters,
  });
  return { emitter, counters };
}

describe("the declared detection-mechanism table", () => {
  it.each(DRIVERS)("is TOTAL over the canonical flag set for driver '%s'", (driverName) => {
    // Walks DRIVER_CAPABILITY_FLAGS, not the table's keys: a table total over itself but stale
    // against the contract fails here, which is what a union growth produces.
    const table = CAPABILITY_DETECTION_TABLES[driverName];
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(Object.hasOwn(table, flag)).toBe(true);
    }
    expect(Object.keys(table).sort()).toStrictEqual([...DRIVER_CAPABILITY_FLAGS].sort());
  });

  it.each(DRIVERS)("declares a recognized mechanism for every flag of '%s'", (driverName) => {
    const table = CAPABILITY_DETECTION_TABLES[driverName];
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      const mechanism = table[flag];
      const source: CapabilityDetectionSource = mechanism.detectionSource;
      expect(["static", "probed"]).toContain(source);
    }
  });

  it.each(DRIVERS)("names a failing conjunct on EVERY static entry of '%s'", (driverName) => {
    const table = CAPABILITY_DETECTION_TABLES[driverName];
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      const mechanism = table[flag];
      if (mechanism.detectionSource !== "static") {
        continue;
      }
      expect(mechanism.failingConjuncts.length).toBeGreaterThan(0);
      for (const conjunct of mechanism.failingConjuncts) {
        expect(SPEC_ADMISSIBILITY_CONJUNCTS).toContain(conjunct);
      }
      expect(mechanism.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(DRIVERS)("declares a real probe on EVERY probed entry of '%s'", (driverName) => {
    const table = CAPABILITY_DETECTION_TABLES[driverName];
    for (const flag of probedFlagsOf(table)) {
      const mechanism = table[flag];
      expect(mechanism.detectionSource).toBe("probed");
      if (mechanism.detectionSource !== "probed") {
        return;
      }
      // EVERY name, not just the first: a conjunctive probe issues them all.
      expect(mechanism.probe.probeNames.length).toBeGreaterThan(0);
      for (const probeName of mechanism.probe.probeNames) {
        expect(probeName.trim().length).toBeGreaterThan(0);
      }
      expect(mechanism.probe.decisiveness.trim().length).toBeGreaterThan(0);
    }
  });

  it("pins WHICH drivers probe — and the corpus still reads a real build", () => {
    // Claude's one candidate entry is static on a measured gap (below), so it dispatches nothing.
    // Pinned so a table edit that promotes or demotes an entry must re-derive the probe-behavior
    // blocks below rather than make them vacuous.
    expect([...PROBING_DRIVERS]).toStrictEqual(["codex"]);
    // …and the reading-of-the-installed-build requirement is still discharged
    // A corpus of entirely static tables would not exercise reading a real build.
    expect(PROBING_DRIVERS.length).toBeGreaterThan(0);
  });

  it("declares Claude `interactive_requests` static on the MEASURED direction gap", () => {
    // The subtypes the flag is consumed as (`can_use_tool`, `elicitation`) are raised by the
    // provider. The pinned build's inbound dispatcher refuses them by name, as it refuses the
    // negative control, so a probe would withdraw the flag on every build that fully carries it.
    const mechanism = CLAUDE_CAPABILITY_DETECTION_TABLE.interactive_requests;
    expect(mechanism.detectionSource).toBe("static");
    if (mechanism.detectionSource !== "static") {
      return;
    }
    expect(mechanism.failingConjuncts).toStrictEqual(["decisive-at-consumption-granularity"]);
    expect(mechanism.rationale).toMatch(/can_use_tool/);
    expect(mechanism.rationale).toMatch(/negative control/);
    // The demotion changes how the value is arrived at, not what the driver can do.
    expect(CLAUDE_CAPABILITY_FLAGS.interactive_requests).toBe(true);
  });

  it("declares Codex `session_goals` as a CONJUNCTIVE probe over both goal methods", () => {
    // The flag is consumed as durable goal operations delivered over a setter and a clearer;
    // probing only the setter would report a build that cannot clear goals as fully capable.
    expect(probeNamesFor(CODEX_CAPABILITY_DETECTION_TABLE, "session_goals")).toStrictEqual([
      "thread/goal/set",
      "thread/goal/clear",
    ]);
  });

  it.each(DRIVERS)("passes its own admissibility screen for '%s'", (driverName) => {
    expect(
      findCapabilityDetectionTableViolations(driverName, CAPABILITY_DETECTION_TABLES[driverName]),
    ).toStrictEqual([]);
  });

  it("fails the screen on a table claiming `probed` with no usable probe", () => {
    // Negative control for the checker: without it, a clean run above is equally consistent with
    // a checker that returns `[]` for everything.
    const malformed: DriverCapabilityDetectionTable = {
      ...CODEX_CAPABILITY_DETECTION_TABLE,
      steer: { detectionSource: "probed", probe: { probeNames: ["  "], decisiveness: "" } },
      rollback: {
        detectionSource: "static",
        failingConjuncts: [] as unknown as readonly [ProbeAdmissibilityConjunct],
        rationale: "   ",
      },
      mcp: {
        detectionSource: "probed",
        // The prohibited name is not first: a screen checking only the leading name would let it
        // reach the wire.
        probe: { probeNames: ["thread/goal/set", "mcp_set_servers"], decisiveness: "x" },
      },
      // A probed entry the type forbids (the tuple makes it unspellable), but a table can arrive
      // from somewhere the compiler did not see.
      session_goals: {
        detectionSource: "probed",
        probe: {
          probeNames: [] as unknown as readonly [string, ...string[]],
          decisiveness: "x",
        },
      },
    };
    const violations = findCapabilityDetectionTableViolations("codex", malformed);
    const reasonsFor = (flag: DriverCapabilityFlag): string =>
      violations
        .filter((violation) => violation.flag === flag)
        .map((violation) => violation.reason)
        .join(" | ");
    expect(reasonsFor("steer")).toMatch(/non-empty probe wire name/);
    expect(reasonsFor("steer")).toMatch(/why its answer is decisive/);
    expect(reasonsFor("rollback")).toMatch(/failing admissibility conjunct/);
    expect(reasonsFor("rollback")).toMatch(/must carry a rationale/);
    expect(reasonsFor("mcp")).toMatch(/prohibited wire name 'mcp_set_servers'/);
    expect(reasonsFor("session_goals")).toMatch(/at least one probe wire name/);
    // The shipped table is clean against the same checker, so the checker is shown able to fire.
    expect(
      findCapabilityDetectionTableViolations("codex", CODEX_CAPABILITY_DETECTION_TABLE),
    ).toStrictEqual([]);
  });

  it("declares `mcp` non-probeable on BOTH drivers, failing zero-turn AND non-mutating", () => {
    for (const driverName of DRIVERS) {
      const mechanism = CAPABILITY_DETECTION_TABLES[driverName].mcp;
      expect(mechanism.detectionSource).toBe("static");
      if (mechanism.detectionSource !== "static") {
        return;
      }
      expect([...mechanism.failingConjuncts].sort()).toStrictEqual(
        ["non-mutating", "zero-turn"].sort(),
      );
    }
  });

  it.each(PROBING_DRIVERS)(
    "declares its withdrawal canary flag as a PROBED entry ('%s')",
    (driverName) => {
      // Pins the pairing the withdrawal tests depend on, so a table edit cannot leave them
      // exercising a flag nobody chose.
      const canary = withdrawalCanaryFor(driverName);
      expect(probedFlagsOf(CAPABILITY_DETECTION_TABLES[driverName])).toContain(canary);
      expect(MATRIX_FLAGS[driverName][canary]).toBe(true);
    },
  );

  it("declares Codex `rollback` non-probeable on the GRANULARITY conjunct", () => {
    const mechanism = CODEX_CAPABILITY_DETECTION_TABLE.rollback;
    expect(mechanism.detectionSource).toBe("static");
    if (mechanism.detectionSource !== "static") {
      return;
    }
    expect(mechanism.failingConjuncts).toStrictEqual(["decisive-at-consumption-granularity"]);
    // The gap is at parameter level: the enumeration proves the method is accepted, not that the
    // boundary field exists on the admitted floor build.
    expect(mechanism.rationale).toMatch(/lastTurnId/);
  });
});

describe("zero billed turns, asserted at the provider transport", () => {
  it.each(DRIVERS)(
    "issues ONLY declared probe names plus the control for '%s'",
    async (driverName) => {
      const transport = new RecordingCapabilityProbeTransport(driverName);
      await readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      });

      const table = CAPABILITY_DETECTION_TABLES[driverName];
      const permitted = new Set<string>([
        CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName],
        ...probedFlagsOf(table).flatMap((flag) => [...probeNamesFor(table, flag)]),
      ]);
      for (const issued of transport.issuedProbeNames) {
        expect(permitted.has(issued)).toBe(true);
      }
    },
  );

  it.each(PROBING_DRIVERS)(
    "issues at least the control and one probe for '%s'",
    async (driverName) => {
      // The non-vacuity half of the assertion above: a transport that recorded
      // nothing would satisfy "only permitted names" trivially.
      const transport = new RecordingCapabilityProbeTransport(driverName);
      await readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      });
      expect(transport.issuedProbeNames.length).toBeGreaterThan(1);
    },
  );

  it.each(PROBING_DRIVERS)(
    "issues no turn-bearing request for '%s' — structurally and in fact",
    async (driverName) => {
      const transport = new RecordingCapabilityProbeTransport(driverName);
      await readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      });

      expect(transport.requests.length).toBeGreaterThan(0);
      for (const request of transport.requests) {
        // No name that starts a thread or a turn is issued. A probe may name a `turn/*` method
        // (`turn/steer` acts on an existing turn), so assert against the prohibited set, not the
        // namespace.
        expect(CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES).not.toContain(request.probeName);
        // Structurally: the request shape carries no message, prompt, content, or
        // The request shape has no message, prompt, content or params member, so a user message
        // cannot be expressed on this seam. It carries the build, which is what a capability
        // answer is about.
        expect(Object.keys(request).sort()).toStrictEqual([
          "boundExecutablePath",
          "channel",
          "driverName",
          "probeName",
        ]);
        expect(request.channel).toBe(CAPABILITY_PROBE_CHANNELS[driverName]);
        expect(request.driverName).toBe(driverName);
        expect(request.boundExecutablePath).toBe(boundPathFor(driverName));
      }
    },
  );

  it.each(DRIVERS)("never issues `mcp_set_servers` for '%s'", async (driverName) => {
    const transport = new RecordingCapabilityProbeTransport(driverName);
    await readCapabilityDetection({
      driverName,
      boundExecutablePath: boundPathFor(driverName),
      exchange: transport.exchange,
    });
    expect(transport.issuedProbeNames).not.toContain("mcp_set_servers");
    // The prohibition holds wherever the name reaches the dispatcher, not only in this run.
    expect(CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES).toContain("mcp_set_servers");
    expect(() => {
      assertProbeWireNameAdmissible("mcp_set_servers");
    }).toThrow(CapabilityProbeProhibitedNameError);
  });

  it("an ATTACH that probes issues no turn-start and no user message (Codex)", async () => {
    const transport = new RecordingCapabilityProbeTransport("codex");
    const sink = {
      declare: () =>
        Promise.resolve({ snapshotChange: "created" as const, cliVersionRefreshed: true }),
    };
    await refreshCodexCapabilities(sink, {
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.issuedProbeNames).not.toContain("turn/start");
    expect(transport.issuedProbeNames).not.toContain("thread/start");
  });

  it("an ATTACH on a probe-less driver dispatches NOTHING at all (Claude)", async () => {
    // With every entry static, the read issues no probe and no negative control: there is no
    // answer a control could protect.
    const transport = new RecordingCapabilityProbeTransport("claude");
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(CLAUDE_VERSION_READING),
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    const result = await reporter.getCapabilities();
    expect(transport.requests).toStrictEqual([]);
    // A driver that probes nothing still declares every flag, from its matrix.
    expect(Object.keys(result.detectionSource ?? {}).sort()).toStrictEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
  });
});

describe("the capability-probe negative control", () => {
  it.each(PROBING_DRIVERS)(
    "is issued FIRST for '%s', before any capability probe",
    async (driverName) => {
      const transport = new RecordingCapabilityProbeTransport(driverName);
      await readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      });
      expect(transport.issuedProbeNames[0]).toBe(CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName]);
    },
  );

  it.each(PROBING_DRIVERS)("fails the whole read when it SUCCEEDS on '%s'", async (driverName) => {
    const control = CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName];
    const transport = new RecordingCapabilityProbeTransport(driverName, {
      replies: { [control]: driverName === "claude" ? claudeSuccessReply() : codexResultReply() },
    });
    await expect(
      readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      }),
    ).rejects.toBeInstanceOf(CapabilityProbeNegativeControlError);
    // It fails before reporting: no capability probe was issued, so there is no reading to use.
    expect(transport.issuedProbeNames).toStrictEqual([control]);
  });

  it("fails the read when the control draws a non-name-level refusal", async () => {
    // A dispatcher answering a contextual error for a name that cannot exist is not doing
    // name-level lookup, so its refusals cannot discriminate a missing name either.
    const control = CAPABILITY_PROBE_NEGATIVE_CONTROLS.codex;
    const transport = new RecordingCapabilityProbeTransport("codex", {
      replies: { [control]: codexCapabilityGatedReply(control) },
    });
    await expect(
      readCapabilityDetection({
        driverName: "codex",
        boundExecutablePath: boundPathFor("codex"),
        exchange: transport.exchange,
      }),
    ).rejects.toBeInstanceOf(CapabilityProbeNegativeControlError);
  });

  it("fails the read when the control's answer is unclassifiable (Codex)", async () => {
    const control = CAPABILITY_PROBE_NEGATIVE_CONTROLS.codex;
    const transport = new RecordingCapabilityProbeTransport("codex", {
      replies: { [control]: "not a json-rpc frame" },
    });
    await expect(
      readCapabilityDetection({
        driverName: "codex",
        boundExecutablePath: boundPathFor("codex"),
        exchange: transport.exchange,
      }),
    ).rejects.toBeInstanceOf(CapabilityProbeNegativeControlError);
  });

  it("is NOT dispatched by a driver whose table declares no probe", async () => {
    // The control is declared for every driver but issued only where it validates something. The
    // reply would fail the read if issued, so a passing read shows the dispatch never happened.
    const control = CAPABILITY_PROBE_NEGATIVE_CONTROLS.claude;
    const transport = new RecordingCapabilityProbeTransport("claude", {
      replies: { [control]: claudeSuccessReply() },
    });
    const reading = await readCapabilityDetection({
      driverName: "claude",
      boundExecutablePath: boundPathFor("claude"),
      exchange: transport.exchange,
    });
    expect(transport.issuedProbeNames).toStrictEqual([]);
    expect(reading.withdrawnFlags).toStrictEqual([]);
    // The declaration stays total over the drivers, so a table that becomes probeable always has
    // a control to dispatch.
    expect(Object.keys(CAPABILITY_PROBE_NEGATIVE_CONTROLS).sort()).toStrictEqual(
      [...DRIVERS].sort(),
    );
  });
});

describe("capability-probe reply classification", () => {
  it("classifies the Claude control-response arms", () => {
    expect(classifyClaudeProbeReply(claudeSuccessReply())).toBe("accepted");
    // A registered subtype refusing for context accepts the name (`get_usage is not supported in
    // this context`); reading it as absence would withdraw a live capability.
    expect(classifyClaudeProbeReply(claudeContextualRefusalReply("get_usage"))).toBe("accepted");
    expect(classifyClaudeProbeReply(claudeUnsupportedSubtypeReply("zzq"))).toBe("unknown-name");
    // Unwrapped inner response — the seam may return either shape.
    expect(classifyClaudeProbeReply({ subtype: "success" })).toBe("accepted");
    expect(classifyClaudeProbeReply({ subtype: "error", error: 42 })).toBe("unrecognized");
    expect(classifyClaudeProbeReply(null)).toBe("unrecognized");
    expect(classifyClaudeProbeReply([])).toBe("unrecognized");
    expect(classifyClaudeProbeReply({ subtype: "mystery" })).toBe("unrecognized");
  });

  it("classifies the Codex JSON-RPC arms", () => {
    expect(classifyCodexProbeReply(codexResultReply(), "turn/steer")).toBe("accepted");
    // `-32602` is one reply a deliberately payload-free probe can draw from an
    // `-32602` is what an accepted method answers a payload-free probe: the schema refused the
    // empty request, which keeps the probe non-mutating. Reading it as absence would withdraw
    // every probed flag.
    expect(classifyCodexProbeReply(codexInvalidParamsReply(), "turn/steer")).toBe("accepted");
    expect(classifyCodexProbeReply(codexUnknownMethodReply("zzq/x"), "zzq/x")).toBe("unknown-name");
    expect(
      classifyCodexProbeReply({ error: { code: -32601, message: "Method not found" } }, "zzq/x"),
    ).toBe("unknown-name");
    expect(classifyCodexProbeReply({ error: { code: "-32600" } }, "zzq/x")).toBe("unrecognized");
    expect(classifyCodexProbeReply({}, "zzq/x")).toBe("unrecognized");
    expect(classifyCodexProbeReply(undefined, "zzq/x")).toBe("unrecognized");
  });

  it("reads the MESSAGE and not only the code on the Codex `-32600` arm", () => {
    // The measured build answers `-32600` both for an unaccepted name and for an accepted name
    // whose payload does not deserialize, so a code-only classifier would withdraw every probed
    // flag. These are the three measured shapes, verbatim.
    expect(classifyCodexProbeReply(codexMissingFieldReply(), "turn/steer")).toBe("accepted");
    expect(
      classifyCodexProbeReply(
        codexCapabilityGatedReply("server/diagnostics"),
        "server/diagnostics",
      ),
    ).toBe("accepted");
    expect(classifyCodexProbeReply(codexUnknownMethodReply("turn/steer"), "turn/steer")).toBe(
      "unknown-name",
    );
  });

  it("resolves every ambiguous Codex `-32600` toward ACCEPTED", () => {
    // Resolution is withdraw-only: a wrong `accepted` keeps the declared matrix, a wrong
    // `unknown-name` silently disables a live capability. First, an enumeration about a variant
    // nested inside an accepted request…
    expect(
      classifyCodexProbeReply(
        codexUnknownVariantReply("on-failure", ["untrusted", "on-request", "granular", "never"]),
        "turn/steer",
      ),
    ).toBe("accepted");
    // …an enumeration that contains the probed name, so the refusal was about something else…
    expect(
      classifyCodexProbeReply(
        codexUnknownVariantReply("turn/steer", ["turn/steer", "thread/start"]),
        "turn/steer",
      ),
    ).toBe("accepted");
    // …and a `-32600` whose message is not a string at all.
    expect(classifyCodexProbeReply({ error: { code: -32600, message: 7 } }, "turn/steer")).toBe(
      "accepted",
    );
  });
});

describe("capability withdrawal is per capability", () => {
  it.each(PROBING_DRIVERS)(
    "withdraws ONLY the refusing flag on '%s', keeping the rest",
    async (driverName) => {
      const table = CAPABILITY_DETECTION_TABLES[driverName];
      const refusedFlag = withdrawalCanaryFor(driverName);
      const refusedName = firstProbeNameFor(table, refusedFlag);
      const transport = new RecordingCapabilityProbeTransport(driverName, {
        replies: {
          [refusedName]:
            driverName === "claude"
              ? claudeUnsupportedSubtypeReply(refusedName)
              : codexUnknownMethodReply(refusedName),
        },
      });

      const reading = await readCapabilityDetection({
        driverName,
        boundExecutablePath: boundPathFor(driverName),
        exchange: transport.exchange,
      });
      expect(reading.withdrawnFlags).toStrictEqual([refusedFlag]);
      expect(reading.diagnostics).toStrictEqual([
        { driverName, flag: refusedFlag, probeName: refusedName, disposition: "unknown-name" },
      ]);

      const resolved = applyCapabilityDetection(MATRIX_FLAGS[driverName], reading);
      expect(resolved[refusedFlag]).toBe(false);
      for (const flag of DRIVER_CAPABILITY_FLAGS) {
        if (flag === refusedFlag) {
          continue;
        }
        expect(resolved[flag]).toBe(MATRIX_FLAGS[driverName][flag]);
      }
      // The provenance stays total and the refusing flag stays `probed`: the withdrawal is the
      // probe's answer, not its absence.
      expect(Object.keys(reading.detectionSource).sort()).toStrictEqual(
        [...DRIVER_CAPABILITY_FLAGS].sort(),
      );
      expect(reading.detectionSource[refusedFlag]).toBe("probed");
    },
  );

  it("withdraws fail-closed on an answer it cannot classify, with a diagnostic", async () => {
    const flag = withdrawalCanaryFor("codex");
    const probeName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, flag);
    const transport = new RecordingCapabilityProbeTransport("codex", {
      replies: { [probeName]: { unexpected: true } },
    });
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(reading.withdrawnFlags).toStrictEqual([flag]);
    expect(reading.diagnostics[0]?.disposition).toBe("unrecognized-reply");
  });

  it("is WITHDRAW-ONLY: a probe never grants a flag the driver declares false", async () => {
    // Codex `output_speed` is false because the provider declares no settable output-speed
    // level, and a probe answering `accepted` must leave it false. Any flag the driver declares
    // false would do.
    expect(CODEX_CAPABILITY_FLAGS.output_speed).toBe(false);
    const transport = new RecordingCapabilityProbeTransport("codex");
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(reading.withdrawnFlags).toStrictEqual([]);
    const resolved = applyCapabilityDetection(CODEX_CAPABILITY_FLAGS, reading);
    expect(resolved.output_speed).toBe(false);
    // …and the resolution is a fresh record: the frozen module constant is shared process-wide
    // and must not be what a caller mutates.
    expect(resolved).not.toBe(CODEX_CAPABILITY_FLAGS);
    expect(Object.isFrozen(resolved)).toBe(false);
  });

  it("fails the whole read when the transport rejects", async () => {
    const probeName = firstProbeNameFor(
      CODEX_CAPABILITY_DETECTION_TABLE,
      withdrawalCanaryFor("codex"),
    );
    const transport = new RecordingCapabilityProbeTransport("codex", {
      rejections: { [probeName]: new Error("pipe closed") },
    });
    const rejection: unknown = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CapabilityProbeTransportError);
    expect(rejection).toBeInstanceOf(CapabilityProbeError);
    expect((rejection as CapabilityProbeTransportError).cause).toBeInstanceOf(Error);
  });
});

describe("detectionSource on the capability report", () => {
  it("is TOTAL over the flag set on a live Claude read", async () => {
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(CLAUDE_VERSION_READING),
      probe: new RecordingCapabilityProbeTransport("claude").exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    const result: GetCapabilitiesResult = await reporter.getCapabilities();
    expect(result.detectionSource).toBeDefined();
    expect(Object.keys(result.detectionSource ?? {}).sort()).toStrictEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(result.detectionSource?.[flag]).toBe(
        CLAUDE_CAPABILITY_DETECTION_TABLE[flag].detectionSource,
      );
    }
  });

  it("is TOTAL over the flag set on a live Codex read", async () => {
    const detection = await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex").exchange,
      recordingDiagnostics().emitter,
    );
    const result = getCodexCapabilities(CODEX_VERSION_READING, detection);
    expect(Object.keys(result.detectionSource ?? {}).sort()).toStrictEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
  });

  it("PROBES ONLY AFTER the floor gate — a below-floor build is never asked", async () => {
    // The Claude reporter refuses every use of a below-floor build beyond the version
    // handshake, and a probe is such a use. Asserted on the transport: the refusal is raised
    // before a single request.
    const transport = new RecordingCapabilityProbeTransport("claude");
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () =>
        Promise.resolve({
          driverName: CLAUDE_DRIVER_NAME,
          resolvedExecutablePath: "/opt/homebrew/bin/claude",
          report: { raw: "2.1.100", semver: "2.1.100" },
        }),
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    await expect(reporter.getCapabilities()).rejects.toBeInstanceOf(
      DriverCliVersionBelowFloorError,
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("returns a REPORT when one probe refuses — the session survives the withdrawal", async () => {
    // Through the driver's own composition: a refusing probe is a per-capability outcome, not a
    // failed read. The declaration lands with one flag withdrawn and its provenance still
    // `probed`.
    const refusedFlag = withdrawalCanaryFor("codex");
    const refusedName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, refusedFlag);
    expect(CODEX_CAPABILITY_FLAGS[refusedFlag]).toBe(true);
    const detection = await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex", {
        replies: { [refusedName]: codexUnknownMethodReply(refusedName) },
      }).exchange,
      recordingDiagnostics().emitter,
    );

    const result = getCodexCapabilities(CODEX_VERSION_READING, detection);
    expect(result.capabilities.flags[refusedFlag]).toBe(false);
    expect(result.detectionSource?.[refusedFlag]).toBe("probed");
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      if (flag === refusedFlag) {
        continue;
      }
      expect(result.capabilities.flags[flag]).toBe(CODEX_CAPABILITY_FLAGS[flag]);
    }
    // The frozen module constant is untouched: a withdrawal on one reading must not poison later
    // declarations in the process.
    expect(CODEX_CAPABILITY_FLAGS[refusedFlag]).toBe(true);
  });

  it("refuses a detection reading taken from another driver's build", async () => {
    const claudeDetection = await readCapabilityDetection({
      driverName: "claude",
      boundExecutablePath: boundPathFor("claude"),
      exchange: new RecordingCapabilityProbeTransport("claude").exchange,
    });
    expect(() => getCodexCapabilities(CODEX_VERSION_READING, claudeDetection)).toThrow(
      /detection reading taken from driver 'claude'/,
    );
  });
});

describe("a flag whose consumers call several wire names", () => {
  const GOAL_NAMES = ["thread/goal/set", "thread/goal/clear"] as const;

  it("dispatches EVERY declared name once when all of them answer", async () => {
    const transport = new RecordingCapabilityProbeTransport("codex");
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    for (const goalName of GOAL_NAMES) {
      expect(transport.issuedProbeNames.filter((issued) => issued === goalName)).toStrictEqual([
        goalName,
      ]);
    }
    expect(reading.withdrawnFlags).toStrictEqual([]);
    // Nothing is issued twice across the read: two flags sharing a name must not double-issue it.
    expect(new Set(transport.issuedProbeNames).size).toBe(transport.issuedProbeNames.length);
  });

  it.each(GOAL_NAMES)("withdraws the flag when '%s' alone is refused", async (refusedName) => {
    // Refusing either name withdraws, so a build that accepts goals it cannot clear is not
    // reported as capable.
    const transport = new RecordingCapabilityProbeTransport("codex", {
      replies: { [refusedName]: codexUnknownMethodReply(refusedName) },
    });
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(reading.withdrawnFlags).toStrictEqual(["session_goals"]);
    expect(reading.diagnostics).toStrictEqual([
      {
        driverName: "codex",
        flag: "session_goals",
        probeName: refusedName,
        disposition: "unknown-name",
      },
    ]);
    const resolved = applyCapabilityDetection(CODEX_CAPABILITY_FLAGS, reading);
    expect(resolved.session_goals).toBe(false);
    expect(resolved.steer).toBe(CODEX_CAPABILITY_FLAGS.steer);
  });

  it("stops at the FIRST refusing name — the rest are not dispatched", async () => {
    const transport = new RecordingCapabilityProbeTransport("codex", {
      replies: { "thread/goal/set": codexUnknownMethodReply("thread/goal/set") },
    });
    await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(transport.issuedProbeNames).toContain("thread/goal/set");
    expect(transport.issuedProbeNames).not.toContain("thread/goal/clear");
  });
});

describe("a detection reading is bound to the build it was read from", () => {
  it("carries the path onto the reading and onto every dispatch", async () => {
    const transport = new RecordingCapabilityProbeTransport("codex");
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: CODEX_VERSION_READING.resolvedExecutablePath,
      exchange: transport.exchange,
    });
    expect(reading.boundExecutablePath).toBe(CODEX_VERSION_READING.resolvedExecutablePath);
    expect(transport.requests.length).toBeGreaterThan(0);
    for (const request of transport.requests) {
      expect(request.boundExecutablePath).toBe(reading.boundExecutablePath);
    }
  });

  it("binds the driver's own read to the executable the version handshake proved", async () => {
    // Threaded from the version reading, not resolved again: a resolver consulted again can
    // answer differently.
    const detection = await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex").exchange,
      recordingDiagnostics().emitter,
    );
    expect(detection.boundExecutablePath).toBe(CODEX_VERSION_READING.resolvedExecutablePath);
  });

  it("REFUSES a report composed from two different executables", async () => {
    // A `PATH` change or installer swap between the version read and the probes would otherwise
    // compose one build's flags onto another build's version, undetectably.
    const detection = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: "/usr/local/bin/codex-replaced-mid-refresh",
      exchange: new RecordingCapabilityProbeTransport("codex").exchange,
    });
    expect(() => getCodexCapabilities(CODEX_VERSION_READING, detection)).toThrow(
      /bound to a different executable/,
    );
  });
});

describe("a successful read that withdrew a flag reaches the diagnostic band", () => {
  it("emits exactly one record and one counter increment per withdrawal", async () => {
    const refusedName = firstProbeNameFor(
      CODEX_CAPABILITY_DETECTION_TABLE,
      withdrawalCanaryFor("codex"),
    );
    const { emitter, counters } = recordingDiagnostics();
    await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex", {
        replies: { [refusedName]: codexUnknownMethodReply(refusedName) },
      }).exchange,
      emitter,
    );

    const records = emitter.recentRecordsOfKind("capability_flag_withdrawn");
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("codex");
    expect(records[0]?.rawWireType).toBe(refusedName);
    expect(records[0]?.details).toStrictEqual({
      flag: withdrawalCanaryFor("codex"),
      probeName: refusedName,
      disposition: "unknown-name",
      boundExecutablePath: CODEX_VERSION_READING.resolvedExecutablePath,
    });
    // A record under a kind whose counter never fired would be invisible to metrics.
    expect(counters.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.capability_flag_withdrawn)).toBe(1);
  });

  it("emits NOTHING when every probe answered", async () => {
    const { emitter, counters } = recordingDiagnostics();
    await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex").exchange,
      emitter,
    );
    expect(emitter.emittedRecordCount()).toBe(0);
    expect(counters.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.capability_flag_withdrawn)).toBe(0);
  });

  it("reports through the SCHEDULER-facing refresh entry too", async () => {
    // The cadence drives this entry, so a withdrawal found on the tenth refresh must be as
    // visible as one found at attach.
    // attach.
    const refusedName = firstProbeNameFor(
      CODEX_CAPABILITY_DETECTION_TABLE,
      withdrawalCanaryFor("codex"),
    );
    const { emitter } = recordingDiagnostics();
    await refreshCodexCapabilities(
      {
        declare: () =>
          Promise.resolve({ snapshotChange: "created" as const, cliVersionRefreshed: true }),
      },
      {
        reading: CODEX_VERSION_READING,
        probe: new RecordingCapabilityProbeTransport("codex", {
          replies: { [refusedName]: codexUnknownMethodReply(refusedName) },
        }).exchange,
        diagnostics: emitter,
      },
    );
    expect(emitter.recentRecordsOfKind("capability_flag_withdrawn")).toHaveLength(1);
  });

  it("distinguishes an unclassifiable answer from a name refusal", async () => {
    const refusedName = firstProbeNameFor(
      CODEX_CAPABILITY_DETECTION_TABLE,
      withdrawalCanaryFor("codex"),
    );
    const { emitter } = recordingDiagnostics();
    await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex", {
        replies: { [refusedName]: { unexpected: true } },
      }).exchange,
      emitter,
    );
    const records = emitter.recentRecordsOfKind("capability_flag_withdrawn");
    expect(records[0]?.details["disposition"]).toBe("unrecognized-reply");
    expect(records[0]?.dispositionReason).toMatch(/could not be classified/);
  });
});

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

function makeWriter(): DriverCapabilitiesWriter {
  let minute = 0;
  return new DriverCapabilitiesWriter(db, () => {
    const stamp = `2026-08-30T12:${(minute++).toString().padStart(2, "0")}:00.000Z`;
    return stamp;
  });
}

// The writer owns change detection; a re-probe only changes the snapshot it compares.
describe("the cadence re-probe and its change detection", () => {
  function poll(
    writer: DriverCapabilitiesWriter,
    transport: RecordingCapabilityProbeTransport,
  ): Promise<DeclareDriverCapabilitiesResult> {
    return refreshCodexCapabilities(writer, {
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
  }

  it("reports ONE changed snapshot when a flag moves true → false over two polls", async () => {
    const writer = makeWriter();
    const probedFlag = withdrawalCanaryFor("codex");
    const probeName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, probedFlag);
    expect(CODEX_CAPABILITY_FLAGS[probedFlag]).toBe(true);

    const first = await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    expect(first.snapshotChange).toBe("created");

    // The re-probe finds the method gone (a mid-lifetime provider replacement); the writer's own
    // change detection produces exactly one update.
    const withdrawing = new RecordingCapabilityProbeTransport("codex", {
      replies: { [probeName]: codexUnknownMethodReply(probeName) },
    });
    const second = await poll(writer, withdrawing);
    expect(second.snapshotChange).toBe("changed");

    // The same withdrawal again changes nothing: a periodic poll must not manufacture churn.
    const third = await poll(
      writer,
      new RecordingCapabilityProbeTransport("codex", {
        replies: { [probeName]: codexUnknownMethodReply(probeName) },
      }),
    );
    expect(third.snapshotChange).toBe("unchanged");
  });

  it("reports an unchanged snapshot on an unchanged poll", async () => {
    const writer = makeWriter();
    const changes: string[] = [];
    for (let pollIndex = 0; pollIndex < 3; pollIndex += 1) {
      const outcome = await poll(writer, new RecordingCapabilityProbeTransport("codex"));
      changes.push(outcome.snapshotChange);
    }
    expect(changes).toStrictEqual(["created", "unchanged", "unchanged"]);
  });

  it("leaves detectionSource ABSENT on a hydrate() reconstruction", async () => {
    // The durable cache persists flag values for change detection, not provenance, so absence
    // reads as "cache reconstruction" rather than "unknown provenance". No column is minted.
    const writer = makeWriter();
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    const hydrated = writer.hydrate(CODEX_DRIVER_NAME);
    expect(hydrated.hit).toBe(true);
    if (!hydrated.hit) {
      return;
    }
    expect(Object.hasOwn(hydrated.result, "detectionSource")).toBe(false);
    expect(hydrated.result.detectionSource).toBeUndefined();
    // The values still round-trip: absence of provenance is not absence of the declaration.
    expect(hydrated.result.capabilities.flags).toStrictEqual({ ...CODEX_CAPABILITY_FLAGS });
  });
});

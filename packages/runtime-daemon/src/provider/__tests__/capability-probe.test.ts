// Per-capability zero-turn detection (Plan-005 T3.24, verifies I-005-10).
//
// Coverage map — the plan's Tests field is the contract, and each clause below
// names the block that discharges it:
//
//   * "the mechanism table is TOTAL over the flag set for each driver, every
//     `static` entry names a failing conjunct, and an entry claiming `probed`
//     without a declared probe fails the suite" — §the mechanism table. The
//     totality half is enforced twice: by the `Record<DriverCapabilityFlag, …>`
//     annotation in the module (a union growth is a compile error) and by an
//     ENUMERATION test here that walks the canonical tuple, because a compile
//     error is invisible to a reader auditing what this suite proves. The
//     checker itself is driven against a deliberately-malformed table so a
//     clean run is evidence rather than an absence of evidence.
//   * "zero billed turns, asserted at the provider transport" — §zero billed
//     turns. Asserted at a recording transport double, NOT at the daemon's
//     event stream: a probe that billed before normal event handling attached
//     would produce neither a `usage.cost_update` row nor a run-lifecycle
//     event, so a daemon-side assertion could not distinguish "no turn" from
//     "no listener".
//   * "no probe issues `mcp_set_servers` at all, asserted at the same transport
//     double" — §zero billed turns.
//   * "the negative control is refused at every probed build, and a probe run
//     whose negative control SUCCEEDS fails the suite rather than reporting
//     capabilities available" — §the negative control.
//   * "a driver whose one probe refuses keeps every other flag and the session"
//     — §withdrawal is per capability.
//   * the classifier reads the MESSAGE and not only the code on the Codex
//     channel — §classification, driven against the measured verbatim shapes the
//     pinned build emits for all three `-32600` cases.
//   * a flag whose consumers call several wire names withdraws on a refusal of
//     ANY of them — §conjunctive probes.
//   * a reading is bound to the executable the version handshake proved, and a
//     composition site refuses two readings that disagree — §build binding.
//   * a withdrawal reaches the driver diagnostic band, and an all-accepted read
//     emits nothing — §withdrawal diagnostics.
//   * "a flag moving `true` → `false` across two polls emits exactly one
//     `runtime_node.capability_updated` and an unchanged poll emits none" —
//     §change-detected emission, over the REAL `DriverCapabilitiesWriter` and a
//     real SQLite handle. A recording sink fake could not discharge this: change
//     detection lives in the writer, so a fake would be asserting its own canned
//     discriminant.
//
// Refs: Plan-005 T3.24, `Spec-005 §Required Behavior`, `Spec-005 §Capability
// discovery`, CP-005-5, `docs/reference/provider-wire/claude.md`,
// `docs/reference/provider-wire/codex.md`.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type CapabilityDetectionSource,
  type DriverCapabilityFlag,
  type GetCapabilitiesResult,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { RuntimeNodeEventEmitter } from "../../node/node-event-emitter.js";
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
import { DriverCapabilitiesWriter } from "../driver-capabilities-writer.js";
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

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const DRIVERS: readonly FlooredDriverName[] = ["claude", "codex"];

/**
 * The closed conjunct set, restated INDEPENDENTLY of the module's type so a
 * table entry that invents a conjunct name is a failing test rather than a
 * silently-accepted string. (The type union would accept only these three, but
 * the type is erased at runtime and this suite is what a reader audits.)
 */
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
 * The drivers whose table declares at least one probe, DERIVED from the tables
 * rather than listed.
 *
 * Deriving it is what keeps the suite honest across a demotion or a promotion:
 * a driver that stops probing drops out of every probe-behaviour block instead
 * of failing them for the wrong reason, and a driver that starts probing joins
 * them. Which drivers are currently in the set is pinned by its own test below,
 * so the membership is never allowed to change silently.
 */
const PROBING_DRIVERS: readonly FlooredDriverName[] = DRIVERS.filter(
  (driverName) => probedFlagsOf(CAPABILITY_DETECTION_TABLES[driverName]).length > 0,
);

/**
 * The flag a probing driver's withdrawal assertions run through, NAMED rather
 * than taken positionally off `probedFlagsOf(...)`.
 *
 * A positional pick silently changes which capability is covered the moment a
 * table grows a probed entry ahead of it — the assertions would keep passing
 * while the flag they were written for went untested. The pairing is itself
 * asserted below, so a canary that stops being probed fails loudly instead of
 * degrading.
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
 * An emitter over a silent log sink and a counting metrics sink.
 *
 * Both halves are asserted, because the record and the counter are the two
 * things the closed-kind pairing exists to keep in step: a record emitted under
 * a kind with no counter would be invisible to an operator watching metrics.
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

// --------------------------------------------------------------------------
// §the mechanism table
// --------------------------------------------------------------------------

// Verifies I-005-10 (the detection table and its named failing conjuncts).
describe("the declared detection-mechanism table", () => {
  it.each(DRIVERS)("is TOTAL over the canonical flag set for driver '%s'", (driverName) => {
    // The ENUMERATION test. It walks `DRIVER_CAPABILITY_FLAGS` rather than the
    // table's own keys, so a table that is total over ITSELF but stale against
    // the contract fails here — which is the failure a union growth produces.
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
    // Claude's one candidate entry is `static` on a MEASURED gap (below), so
    // this driver dispatches nothing. Pinned rather than left implicit: a table
    // edit that promotes or demotes an entry must re-derive the probe-behaviour
    // blocks below rather than silently make them vacuous.
    expect([...PROBING_DRIVERS]).toStrictEqual(["codex"]);
    // …and the reading-of-the-installed-build requirement is still discharged
    // somewhere, which a corpus of entirely `static` tables would not be.
    expect(PROBING_DRIVERS.length).toBeGreaterThan(0);
  });

  it("declares Claude `interactive_requests` static on the MEASURED direction gap", () => {
    // The subtypes the flag is consumed as are ones the provider RAISES. The
    // pinned build's inbound dispatcher refuses all three by name, exactly as it
    // refuses the negative control, so a probe here would withdraw the flag on
    // every read of a build that fully carries it.
    const mechanism = CLAUDE_CAPABILITY_DETECTION_TABLE.interactive_requests;
    expect(mechanism.detectionSource).toBe("static");
    if (mechanism.detectionSource !== "static") {
      return;
    }
    expect(mechanism.failingConjuncts).toStrictEqual(["decisive-at-consumption-granularity"]);
    expect(mechanism.rationale).toMatch(/can_use_tool/);
    expect(mechanism.rationale).toMatch(/negative control/);
    // The matrix still DECLARES the capability: the demotion is about how the
    // value is arrived at, never about what the driver can do.
    expect(CLAUDE_CAPABILITY_FLAGS.interactive_requests).toBe(true);
  });

  it("declares Codex `session_goals` as a CONJUNCTIVE probe over both goal methods", () => {
    // The flag is consumed as durable goal operations, which this driver
    // delivers over a setter AND a clearer. Probing only the setter would report
    // a build that accepts goals it cannot clear as fully capable.
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
    // The NEGATIVE CONTROL for the checker itself. Without this, a clean run
    // above is equally consistent with a checker that returns `[]` for
    // everything, and "no violations" would be evidence of nothing.
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
        // The prohibited name is NOT first: a screen that checked only the
        // leading name would pass this table and let the name reach the wire.
        probe: { probeNames: ["thread/goal/set", "mcp_set_servers"], decisiveness: "x" },
      },
      // A `probed` entry the TYPE forbids — the tuple makes it unspellable — but
      // which this checker is still reachable with, because a table can arrive
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
    // …and the SHIPPED tables are clean against the same checker, so the two
    // results together are evidence rather than a checker that never fires.
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
      // Pins the pairing the withdrawal assertions below depend on. Without this,
      // a table edit could leave those tests exercising a flag nobody chose.
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
    // The reason is the parameter-level gap, and it must stay stated: the
    // enumeration proves the METHOD is accepted, never that the boundary field
    // exists on the admitted floor build.
    expect(mechanism.rationale).toMatch(/lastTurnId/);
  });
});

// --------------------------------------------------------------------------
// §zero billed turns
// --------------------------------------------------------------------------

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
        // In fact: no name that STARTS a thread or a turn is ever issued. (A
        // probe may legitimately name a `turn/*` method — `turn/steer` acts on an
        // existing turn and the probe connection has none — so the assertion is
        // against the prohibited set rather than against the namespace.)
        expect(CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES).not.toContain(request.probeName);
        // Structurally: the request shape carries no message, prompt, content, or
        // params member at all, so a user message cannot be expressed on this
        // seam even by a caller that wanted to. It carries the BUILD, which is
        // the one thing a capability answer is about.
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
    // And the prohibition is a property of the daemon, not of this run: the
    // name is refused wherever it reaches the dispatcher.
    expect(CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES).toContain("mcp_set_servers");
    expect(() => {
      assertProbeWireNameAdmissible("mcp_set_servers");
    }).toThrow(CapabilityProbeProhibitedNameError);
  });

  it("an ATTACH that probes issues no turn-start and no user message (Codex)", async () => {
    const transport = new RecordingCapabilityProbeTransport("codex");
    const sink = {
      declare: () => Promise.resolve({ emitted: "declared" as const, cliVersionRefreshed: true }),
    };
    await refreshCodexCapabilities(sink, {
      sessionId: "session-probe",
      nodeId: "node-probe",
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.issuedProbeNames).not.toContain("turn/start");
    expect(transport.issuedProbeNames).not.toContain("thread/start");
  });

  it("an ATTACH on a probe-less driver dispatches NOTHING at all (Claude)", async () => {
    // The strongest form of the zero-turn claim for this driver: with every
    // entry `static`, the read issues no capability probe and no negative
    // control either — there is no answer a control could protect.
    const transport = new RecordingCapabilityProbeTransport("claude");
    const reporter = new ClaudeCapabilityReporter({
      readSpawnedVersion: () => Promise.resolve(CLAUDE_VERSION_READING),
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
    const result = await reporter.getCapabilities();
    expect(transport.requests).toStrictEqual([]);
    // …and the report is still complete: a driver that probes nothing still
    // declares every flag, from its matrix.
    expect(Object.keys(result.detectionSource ?? {}).sort()).toStrictEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
  });
});

// --------------------------------------------------------------------------
// §the negative control
// --------------------------------------------------------------------------

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
    // And it fails BEFORE reporting anything: no capability probe was issued at
    // all, so there is no reading to be tempted into using.
    expect(transport.issuedProbeNames).toStrictEqual([control]);
  });

  it("fails the read when the control draws a non-name-level refusal", async () => {
    // A dispatcher answering a CONTEXTUAL error for a name that cannot exist is
    // not doing name-level lookup — so its refusals cannot be trusted to
    // discriminate a missing name either.
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
    // The control is declared for every driver and issued only where it
    // validates something. The reply here would FAIL the read if it were
    // issued, so a passing read is evidence the dispatch never happened rather
    // than evidence the answer was ignored.
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
    // The declaration is still total over the drivers, so a table that becomes
    // probeable is never left without a control to dispatch.
    expect(Object.keys(CAPABILITY_PROBE_NEGATIVE_CONTROLS).sort()).toStrictEqual(
      [...DRIVERS].sort(),
    );
  });
});

// --------------------------------------------------------------------------
// §classification
// --------------------------------------------------------------------------

describe("capability-probe reply classification", () => {
  it("classifies the Claude control-response arms", () => {
    expect(classifyClaudeProbeReply(claudeSuccessReply())).toBe("accepted");
    // A registered subtype refusing for CONTEXT is acceptance of the NAME —
    // the wire reference's own `get_usage is not supported in this context`
    // arm. Reading it as absence would withdraw a live capability.
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
    // ACCEPTED method — the schema refused the empty request, which is exactly
    // what keeps the probe non-mutating. Classifying it as absence would
    // withdraw every probed flag on every build.
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
    // The measured build answers `-32600` for BOTH an unaccepted name and an
    // accepted name whose payload does not deserialize, so a classifier keyed on
    // the code alone withdraws every probed flag on every real read. These are
    // the three measured shapes, verbatim.
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
    // Resolution is withdraw-only, so a wrong `accepted` preserves the declared
    // matrix while a wrong `unknown-name` silently disables a live capability.
    // An enumeration about a variant NESTED inside an accepted request…
    expect(
      classifyCodexProbeReply(
        codexUnknownVariantReply("on-failure", ["untrusted", "on-request", "granular", "never"]),
        "turn/steer",
      ),
    ).toBe("accepted");
    // …an enumeration that CONTAINS the probed name, which can only mean the
    // refusal was about something else…
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

// --------------------------------------------------------------------------
// §withdrawal is per capability
// --------------------------------------------------------------------------

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
      // The provenance stays TOTAL and the refusing flag stays `probed`: it WAS
      // probed, and the withdrawal is the probe's answer rather than its absence.
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
    // Codex `transcript_replay` is `false` as a scope boundary — the replay leg
    // is a later task's. Every probe answering `accepted` must leave it `false`,
    // because a flag declared ahead of the code that reads it is a promise no
    // caller can keep.
    expect(CODEX_CAPABILITY_FLAGS.transcript_replay).toBe(false);
    const transport = new RecordingCapabilityProbeTransport("codex");
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(reading.withdrawnFlags).toStrictEqual([]);
    const resolved = applyCapabilityDetection(CODEX_CAPABILITY_FLAGS, reading);
    expect(resolved.transcript_replay).toBe(false);
    // …and the resolution is a FRESH record: the frozen module constant is
    // shared process-wide and must not be the object a caller mutates.
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

// --------------------------------------------------------------------------
// §the report
// --------------------------------------------------------------------------

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
    // `Spec-005` refuses every use of a below-floor build beyond the version
    // handshake, and a probe is such a use. Asserted on the transport: the
    // refusal is not merely raised, it is raised before a single request.
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
    // End-to-end through the driver's own composition: a refusing probe is a
    // per-capability outcome, not a failure of the read. The declaration still
    // lands, with exactly one flag withdrawn and its provenance still `probed`.
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
    // …and the frozen module constant is untouched: a withdrawal on one reading
    // must not poison every later declaration in the process.
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

// --------------------------------------------------------------------------
// §conjunctive probes
// --------------------------------------------------------------------------

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
    // And nothing is issued twice across the whole read: two flags sharing a
    // name must not double-issue it.
    expect(new Set(transport.issuedProbeNames).size).toBe(transport.issuedProbeNames.length);
  });

  it.each(GOAL_NAMES)("withdraws the flag when '%s' alone is refused", async (refusedName) => {
    // The conjunction is the assertion: refusing EITHER name withdraws, so a
    // build that accepts goals it cannot clear is not reported as capable.
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

// --------------------------------------------------------------------------
// §build binding
// --------------------------------------------------------------------------

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
    // Threaded from the version reading rather than resolved a second time: a
    // resolver consulted again can legitimately answer differently.
    const detection = await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      new RecordingCapabilityProbeTransport("codex").exchange,
      recordingDiagnostics().emitter,
    );
    expect(detection.boundExecutablePath).toBe(CODEX_VERSION_READING.resolvedExecutablePath);
  });

  it("REFUSES a report composed from two different executables", async () => {
    // The failure this binding exists to catch: a `PATH` change or an installer
    // swap between the version read and the probes would otherwise compose one
    // build's flags onto another build's version, undetectably.
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

// --------------------------------------------------------------------------
// §withdrawal diagnostics
// --------------------------------------------------------------------------

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
    // The counter half: a record under a kind whose counter never fired would be
    // invisible to an operator watching metrics.
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
    // The wiring that matters operationally: the cadence drives this entry, so a
    // withdrawal found on the tenth refresh must be as visible as one found at
    // attach.
    const refusedName = firstProbeNameFor(
      CODEX_CAPABILITY_DETECTION_TABLE,
      withdrawalCanaryFor("codex"),
    );
    const { emitter } = recordingDiagnostics();
    await refreshCodexCapabilities(
      {
        declare: () => Promise.resolve({ emitted: "declared" as const, cliVersionRefreshed: true }),
      },
      {
        sessionId: "session-diag",
        nodeId: "node-diag",
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

// --------------------------------------------------------------------------
// §change-detected emission (real writer, real SQLite)
// --------------------------------------------------------------------------

class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(11) as Ed25519PrivateKey;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(new Error("unused by this suite"));
  }
}

const POLL_SESSION_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
const POLL_NODE_ID = "node-01J0ND0000NN5J5J5J5J5J5K";

let db: DatabaseType;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  if (db.open) {
    db.close();
  }
});

function makeWriter(): DriverCapabilitiesWriter {
  let idCounter = 0;
  let minute = 0;
  const emitter = new RuntimeNodeEventEmitter({
    sessionEvents: new EventLogService({ db, signingKeySource: new FixedDaemonSigningKeySource() }),
    newEventId: () => `probe-evt-${(idCounter++).toString()}`,
  });
  return new DriverCapabilitiesWriter(db, emitter, () => {
    const stamp = `2026-08-30T12:${(minute++).toString().padStart(2, "0")}:00.000Z`;
    return stamp;
  });
}

function readCapabilityEventTypes(): readonly string[] {
  return db
    .prepare<[string], { type: string }>(
      "SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence ASC",
    )
    .all(POLL_SESSION_ID)
    .map((row) => row.type);
}

// Verifies the change-detected emission obligation (CP-005-5): the writer
// owns the discriminant, and a re-probe only changes the snapshot it compares.
describe("the cadence re-probe and its change-detected emission", () => {
  async function poll(
    writer: DriverCapabilitiesWriter,
    transport: RecordingCapabilityProbeTransport,
  ): Promise<void> {
    await refreshCodexCapabilities(writer, {
      sessionId: POLL_SESSION_ID,
      nodeId: POLL_NODE_ID,
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: recordingDiagnostics().emitter,
    });
  }

  it("emits exactly ONE capability_updated when a flag moves true → false across two polls", async () => {
    const writer = makeWriter();
    const probedFlag = withdrawalCanaryFor("codex");
    const probeName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, probedFlag);
    expect(CODEX_CAPABILITY_FLAGS[probedFlag]).toBe(true);

    // Poll 1 — the build carries the surface.
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    expect(readCapabilityEventTypes()).toStrictEqual(["runtime_node.capability_declared"]);

    // Poll 2 — the RE-PROBE finds the method gone (a mid-lifetime provider
    // replacement). The withdrawal changes the snapshot, so the writer's own
    // change detection produces exactly one update.
    const withdrawing = new RecordingCapabilityProbeTransport("codex", {
      replies: { [probeName]: codexUnknownMethodReply(probeName) },
    });
    await poll(writer, withdrawing);
    expect(readCapabilityEventTypes()).toStrictEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);

    // Poll 3 — the same withdrawal again. Nothing changed, so nothing is
    // appended: a periodic poll must not manufacture timeline churn.
    await poll(
      writer,
      new RecordingCapabilityProbeTransport("codex", {
        replies: { [probeName]: codexUnknownMethodReply(probeName) },
      }),
    );
    expect(readCapabilityEventTypes()).toHaveLength(2);
  });

  it("emits NOTHING on an unchanged poll", async () => {
    const writer = makeWriter();
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    expect(readCapabilityEventTypes()).toStrictEqual(["runtime_node.capability_declared"]);
  });

  it("leaves detectionSource ABSENT on a hydrate() reconstruction", async () => {
    // The live-scoped half of the member's contract: the durable cache persists
    // flag VALUES for change detection and not provenance, so absence here reads
    // as "cache reconstruction" rather than as "unknown provenance". No column
    // is minted, and this is the assertion that keeps it that way.
    const writer = makeWriter();
    await poll(writer, new RecordingCapabilityProbeTransport("codex"));
    const hydrated = writer.hydrate(CODEX_DRIVER_NAME);
    expect(hydrated.hit).toBe(true);
    if (!hydrated.hit) {
      return;
    }
    expect(Object.hasOwn(hydrated.result, "detectionSource")).toBe(false);
    expect(hydrated.result.detectionSource).toBeUndefined();
    // The VALUES still round-trip: absence of provenance is not absence of the
    // declaration.
    expect(hydrated.result.capabilities.flags).toStrictEqual({ ...CODEX_CAPABILITY_FLAGS });
  });
});

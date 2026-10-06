// Zero-turn capability detection: the detection-mechanism table, the negative control that
// validates the probe channel, per-capability withdrawal, and the re-probe's change detection.
// Probes are asserted at a recording transport double, since a probe that billed emits no event.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { openDatabase } from "../../../session/migration-runner.js";
import { makeAdvancingClock } from "../../../__fixtures__/advancing-clock.js";
import {
  RecordingCapabilityProbeTransport,
  type DefaultProbeReply,
} from "../__fixtures__/probe-doubles.js";
import {
  claudeDefaultProbeReply,
  claudeSuccessReply,
} from "../../driver/claude/__fixtures__/capability-probe-replies.js";
import {
  codexDefaultProbeReply,
  codexResultReply,
  codexUnknownMethodReply,
} from "../../driver/codex/__fixtures__/capability-probe-replies.js";
import {
  CapabilityProbeNegativeControlError,
  CapabilityProbeProhibitedNameError,
  applyCapabilityDetection,
  assertProbeWireNameAdmissible,
  readCapabilityDetection,
  type CapabilityDetectionMechanism,
  type DriverCapabilityDetectionTable,
} from "../probe.js";
import {
  DriverCapabilitiesWriter,
  type DeclareDriverCapabilitiesResult,
} from "../../driver/capabilities-writer.js";
import { makeSilentDriverDiagnostics } from "../../__fixtures__/silent-driver-diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../../driver/claude/capabilities.js";
import {
  CODEX_CAPABILITY_FLAGS,
  CODEX_DRIVER_NAME,
  getCodexCapabilities,
  readCodexCapabilityDetection,
  refreshCodexCapabilities,
} from "../../driver/codex/capabilities.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../../driver/descriptor.js";
import type { SpawnedProviderVersionReading } from "../../spawned-version.js";

const DRIVERS: readonly ProviderName[] = ["claude", "codex"];

const CODEX_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable =
  PROVIDER_DRIVER_DESCRIPTORS.codex.capabilityDetectionTable;

/** Each driver's measured probe replies: its default answer per name and its success arm. */
const PROBE_REPLIES: Readonly<
  Record<ProviderName, { readonly defaultReply: DefaultProbeReply; readonly success: unknown }>
> = {
  claude: { defaultReply: claudeDefaultProbeReply, success: claudeSuccessReply() },
  codex: { defaultReply: codexDefaultProbeReply, success: codexResultReply() },
};

function probeTransportFor(
  driverName: ProviderName,
  replies: Readonly<Record<string, unknown>> = {},
): RecordingCapabilityProbeTransport {
  return new RecordingCapabilityProbeTransport(PROBE_REPLIES[driverName].defaultReply, {
    replies,
  });
}

const CLAUDE_VERSION_READING: SpawnedProviderVersionReading = {
  driverName: CLAUDE_DRIVER_NAME,
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
  report: { rawVersion: "2.1.251", parsedVersion: "2.1.251" },
};

const CODEX_VERSION_READING: SpawnedProviderVersionReading = {
  driverName: CODEX_DRIVER_NAME,
  resolvedExecutablePath: "/opt/homebrew/Cellar/codex/0.150.1/bin/codex",
  report: { rawVersion: "codex-cli 0.150.1", parsedVersion: "0.150.1" },
};

function probedFlagsOf(table: DriverCapabilityDetectionTable): DriverCapabilityFlag[] {
  return (Object.entries(table) as [DriverCapabilityFlag, CapabilityDetectionMechanism][]).flatMap(
    ([flag, mechanism]) => (mechanism.detectionSource === "probed" ? [flag] : []),
  );
}

const VERSION_READINGS: Readonly<Record<ProviderName, SpawnedProviderVersionReading>> = {
  claude: CLAUDE_VERSION_READING,
  codex: CODEX_VERSION_READING,
};

/** The build a driver's detection read is bound to, from its version reading. */
function boundPathFor(driverName: ProviderName): string {
  return VERSION_READINGS[driverName].resolvedExecutablePath;
}

/** The drivers whose table declares a probe, derived so a table edit cannot make a test vacuous. */
const PROBING_DRIVERS: readonly ProviderName[] = DRIVERS.filter(
  (driverName) =>
    probedFlagsOf(PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityDetectionTable).length > 0,
);

/** The probed flag a withdrawal assertion runs through, named so a table edit cannot swap it. */
const WITHDRAWAL_CANARY_FLAG: Readonly<Partial<Record<ProviderName, DriverCapabilityFlag>>> = {
  codex: "steer",
};

function withdrawalCanaryFor(driverName: ProviderName): DriverCapabilityFlag {
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

describe("zero billed turns, asserted at the provider transport", () => {
  it.each(PROBING_DRIVERS)(
    "issues no turn-bearing request for '%s' — structurally and in fact",
    async (driverName) => {
      const transport = probeTransportFor(driverName);
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
        expect(
          PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeProhibitedNames,
        ).not.toContain(request.probeName);
        // The request shape has no message, prompt, content or params member, so a user message
        // cannot be expressed on this seam. It carries the build, which is what a capability
        // answer is about.
        expect(Object.keys(request).sort()).toStrictEqual([
          "boundExecutablePath",
          "channel",
          "driverName",
          "probeName",
        ]);
        expect(request.channel).toBe(
          PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeChannel,
        );
        expect(request.driverName).toBe(driverName);
        expect(request.boundExecutablePath).toBe(boundPathFor(driverName));
      }
    },
  );

  it.each(DRIVERS)("never issues a prohibited name for '%s'", async (driverName) => {
    const transport = probeTransportFor(driverName);
    await readCapabilityDetection({
      driverName,
      boundExecutablePath: boundPathFor(driverName),
      exchange: transport.exchange,
    });
    // The prohibition holds wherever the name reaches the dispatcher, not only in this run.
    for (const probeName of PROVIDER_DRIVER_DESCRIPTORS[driverName]
      .capabilityProbeProhibitedNames) {
      expect(transport.issuedProbeNames).not.toContain(probeName);
      expect(() => {
        assertProbeWireNameAdmissible(driverName, probeName);
      }).toThrow(CapabilityProbeProhibitedNameError);
    }
  });

  it("refuses the set-replacing `mcp_set_servers` reconcile at the dispatcher (Claude)", () => {
    expect(() => {
      assertProbeWireNameAdmissible("claude", "mcp_set_servers");
    }).toThrow(CapabilityProbeProhibitedNameError);
  });

  it("an ATTACH that probes issues no turn-start and no user message (Codex)", async () => {
    const transport = probeTransportFor("codex");
    const sink = {
      declare: () =>
        Promise.resolve({ snapshotChange: "created" as const, cliVersionRefreshed: true }),
    };
    await refreshCodexCapabilities(sink, {
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: makeSilentDriverDiagnostics(),
    });
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.issuedProbeNames).not.toContain("turn/start");
    expect(transport.issuedProbeNames).not.toContain("thread/start");
  });
});

describe("the capability-probe negative control", () => {
  it.each(PROBING_DRIVERS)("fails the whole read when it SUCCEEDS on '%s'", async (driverName) => {
    const control = PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeNegativeControl;
    const transport = probeTransportFor(driverName, {
      [control]: PROBE_REPLIES[driverName].success,
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

  it("fails the read when the control's answer is unclassifiable (Codex)", async () => {
    const control = PROVIDER_DRIVER_DESCRIPTORS.codex.capabilityProbeNegativeControl;
    const transport = probeTransportFor("codex", { [control]: "not a json-rpc frame" });
    await expect(
      readCapabilityDetection({
        driverName: "codex",
        boundExecutablePath: boundPathFor("codex"),
        exchange: transport.exchange,
      }),
    ).rejects.toBeInstanceOf(CapabilityProbeNegativeControlError);
  });
});

describe("capability withdrawal is per capability", () => {
  it("withdraws fail-closed on an answer it cannot classify, with a diagnostic", async () => {
    const flag = withdrawalCanaryFor("codex");
    const probeName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, flag);
    const transport = probeTransportFor("codex", { [probeName]: { unexpected: true } });
    const reading = await readCapabilityDetection({
      driverName: "codex",
      boundExecutablePath: boundPathFor("codex"),
      exchange: transport.exchange,
    });
    expect(reading.withdrawnFlags).toStrictEqual([flag]);
    expect(reading.diagnostics[0]?.disposition).toBe("unrecognized-reply");
  });
});

describe("detectionSource on the capability report", () => {
  it("returns a REPORT when one probe refuses; the session survives the withdrawal", async () => {
    // Through the driver's own composition: a refusing probe is a per-capability outcome, not a
    // failed read. The declaration lands with one flag withdrawn and its provenance still
    // `probed`.
    const refusedFlag = withdrawalCanaryFor("codex");
    const refusedName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, refusedFlag);
    expect(CODEX_CAPABILITY_FLAGS[refusedFlag]).toBe(true);
    const detection = await readCodexCapabilityDetection(
      CODEX_VERSION_READING,
      probeTransportFor("codex", { [refusedName]: codexUnknownMethodReply(refusedName) }).exchange,
      makeSilentDriverDiagnostics(),
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
});

describe("a flag whose consumers call several wire names", () => {
  const GOAL_NAMES = ["thread/goal/set", "thread/goal/clear"] as const;

  it.each(GOAL_NAMES)("withdraws the flag when '%s' alone is refused", async (refusedName) => {
    // Refusing either name withdraws, so a build that accepts goals it cannot clear is not
    // reported as capable.
    const transport = probeTransportFor("codex", {
      [refusedName]: codexUnknownMethodReply(refusedName),
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

// The writer owns change detection; a re-probe only changes the snapshot it compares.
describe("a re-probe's change detection", () => {
  function reprobe(
    writer: DriverCapabilitiesWriter,
    transport: RecordingCapabilityProbeTransport,
  ): Promise<DeclareDriverCapabilitiesResult> {
    return refreshCodexCapabilities(writer, {
      reading: CODEX_VERSION_READING,
      probe: transport.exchange,
      diagnostics: makeSilentDriverDiagnostics(),
    });
  }

  it("reports a changed snapshot when a re-probe withdraws a flag", async () => {
    const writer = new DriverCapabilitiesWriter(db, makeAdvancingClock());
    const probedFlag = withdrawalCanaryFor("codex");
    const probeName = firstProbeNameFor(CODEX_CAPABILITY_DETECTION_TABLE, probedFlag);
    expect(CODEX_CAPABILITY_FLAGS[probedFlag]).toBe(true);

    const first = await reprobe(writer, probeTransportFor("codex"));
    expect(first.snapshotChange).toBe("created");

    // The re-probe finds the method gone (a mid-lifetime provider replacement); the writer's own
    // change detection produces exactly one update.
    const withdrawing = probeTransportFor("codex", {
      [probeName]: codexUnknownMethodReply(probeName),
    });
    const second = await reprobe(writer, withdrawing);
    expect(second.snapshotChange).toBe("changed");
  });
});

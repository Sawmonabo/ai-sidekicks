// Zero-turn capability detection: the negative control that validates the probe channel, the
// classification of Claude's and Codex's recorded probe replies, and per-capability withdrawal.
// Probes are asserted at a recording transport double, since a probe that billed emits no event.

import { describe, expect, it } from "vitest";

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

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
  CAPABILITY_PROBE_NEGATIVE_CONTROLS,
  CODEX_CAPABILITY_DETECTION_TABLE,
  CapabilityProbeNegativeControlError,
  applyCapabilityDetection,
  classifyClaudeProbeReply,
  classifyCodexProbeReply,
  readCapabilityDetection,
  type CapabilityDetectionMechanism,
  type DriverCapabilityDetectionTable,
} from "../capability-probe.js";
import type { FlooredDriverName } from "../capability-refresh.js";
import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../drivers/claude/capabilities.js";
import {
  CODEX_CAPABILITY_FLAGS,
  CODEX_DRIVER_NAME,
  getCodexCapabilities,
  readCodexCapabilityDetection,
} from "../drivers/codex/capabilities.js";
import type { SpawnedProviderVersionReading } from "../version-gate.js";

const DRIVERS: readonly FlooredDriverName[] = ["claude", "codex"];

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

/** The drivers whose table declares a probe, derived so a table edit cannot make a test vacuous. */
const PROBING_DRIVERS: readonly FlooredDriverName[] = DRIVERS.filter(
  (driverName) => probedFlagsOf(CAPABILITY_DETECTION_TABLES[driverName]).length > 0,
);

/** The probed flag a withdrawal assertion runs through, named so a table edit cannot swap it. */
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

describe("the capability-probe negative control", () => {
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
});

describe("detectionSource on the capability report", () => {
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
      new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } }),
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
});

// What the shell's condition means for a control, asserted arm by arm.
//
// This vocabulary is the console's answer to "may I send this", and every surface that
// disables a control reads it. Two properties carry the whole design and both are
// asserted here against their own controls: exactly the six mutating methods are
// blocked and no others, and silence is not an outage.

import { describe, expect, it } from "vitest";

import {
  MUTATING_DAEMON_METHODS,
  UNREPORTED_SHELL_STATE,
  describeShellConnection,
  isMutatingDaemonMethod,
  shellBlockForMethod,
  shellMutationBlock,
  shellReportsAreEqual,
  type ShellConnection,
  type ShellReport,
  type ShellState,
} from "./shell-state.js";

function stateWith(connection: ShellConnection): ShellState {
  return { ...UNREPORTED_SHELL_STATE, connection };
}

const REPORTED_CONNECTIONS: readonly ShellConnection[] = [
  { kind: "probing" },
  { kind: "starting" },
  { kind: "connected" },
  { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
  { kind: "version-incompatible" },
  { kind: "offline", attemptLimit: 5, lastError: "spawn ENOENT" },
  { kind: "stopped" },
];

describe("the mutating method set", () => {
  it("is exactly the six the daemon registers", () => {
    expect([...MUTATING_DAEMON_METHODS]).toEqual([
      "session.create",
      "session.join",
      "driver.interruptRun",
      "driver.applyIntervention",
      "driver.respondToRequest",
      "driver.compactContext",
    ]);
  });

  it("does not claim a read is mutating — the control", () => {
    // Ten methods stay live through every outage, and the whole read-only design is
    // wrong if one of them is caught in the predicate.
    for (const method of [
      "session.read",
      "session.subscribe",
      "presence.read",
      "presence.subscribe",
      "driver.listCapabilities",
      "driver.listModels",
      "driver.listModes",
      "driver.listProviderCommands",
      "driver.subscribeEvents",
      "daemon.hello",
    ]) {
      expect(isMutatingDaemonMethod(method), method).toBe(false);
    }
  });
});

describe("shellMutationBlock", () => {
  it("blocks nothing before anything has been reported", () => {
    // Silence is not an outage. Treating it as one would disable every mutating
    // control in every shipped window, which is the renderer deriving an eligibility
    // nobody told it.
    expect(shellMutationBlock(UNREPORTED_SHELL_STATE)).toBeUndefined();
  });

  it("blocks nothing while connected", () => {
    expect(shellMutationBlock(stateWith({ kind: "connected" }))).toBeUndefined();
  });

  it("names a cause on every other arm, and never an empty one", () => {
    for (const connection of REPORTED_CONNECTIONS) {
      if (connection.kind === "connected") {
        continue;
      }
      const block = shellMutationBlock(stateWith(connection));
      expect(block, connection.kind).toBeDefined();
      expect(block?.code.length ?? 0, connection.kind).toBeGreaterThan(0);
      expect(block?.detail.length ?? 0, connection.kind).toBeGreaterThan(0);
    }
  });

  it("carries the attempt count into the reconnecting cause", () => {
    const block = shellMutationBlock(
      stateWith({ kind: "reconnecting", attempt: 3, attemptLimit: 5 }),
    );
    expect(block?.detail).toContain("attempt 3 of 5");
  });

  it("tells a stopped runtime apart from an unreachable one", () => {
    // Folding the two would report a runtime somebody turned off as one that could
    // not be reached, which sends a person looking for a fault that is not there.
    expect(shellMutationBlock(stateWith({ kind: "stopped" }))?.code).toBe("shell-stopped");
    expect(
      shellMutationBlock(stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined }))
        ?.code,
    ).toBe("shell-offline");
  });
});

describe("shellBlockForMethod", () => {
  it("blocks every mutating method while the shell is offline", () => {
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    for (const method of MUTATING_DAEMON_METHODS) {
      expect(shellBlockForMethod(offline, method), method).toBeDefined();
    }
  });

  it("leaves reads live through the same outage — the control", () => {
    const offline = stateWith({ kind: "offline", attemptLimit: 5, lastError: undefined });
    expect(shellBlockForMethod(offline, "session.read")).toBeUndefined();
    expect(shellBlockForMethod(offline, "driver.subscribeEvents")).toBeUndefined();
  });
});

describe("describeShellConnection", () => {
  it("answers a non-empty sentence for every supervisor state", () => {
    const described = new Set<string>();
    for (const connection of [{ kind: "unreported" } as const, ...REPORTED_CONNECTIONS]) {
      const sentence = describeShellConnection(connection);
      expect(sentence.length, connection.kind).toBeGreaterThan(0);
      described.add(sentence);
    }
    // Distinct per state: two states sharing a sentence is a state a person cannot
    // tell they are in.
    expect(described.size).toBe(REPORTED_CONNECTIONS.length + 1);
  });
});

describe("shellReportsAreEqual", () => {
  const base: ShellReport = {
    connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
    negotiation: undefined,
    lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
    transport: "loopback",
    keystore: "unavailable",
  };

  it("holds two identical reports equal across object identity", () => {
    expect(shellReportsAreEqual(base, { ...base, connection: { ...base.connection } })).toBe(true);
  });

  it("sees the attempt move", () => {
    // The one that matters: a ladder that advanced is a different report, and a
    // comparison that missed it would freeze the count on screen at its first value.
    expect(
      shellReportsAreEqual(base, {
        ...base,
        connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
      }),
    ).toBe(false);
  });

  it("sees the transport and the keystore move", () => {
    expect(shellReportsAreEqual(base, { ...base, transport: "os-local" })).toBe(false);
    expect(shellReportsAreEqual(base, { ...base, keystore: "available" })).toBe(false);
  });

  it("sees the handshake move", () => {
    expect(
      shellReportsAreEqual(base, {
        ...base,
        negotiation: {
          compatible: false,
          daemonProtocolVersion: "2026-04-30",
          consoleProtocolVersion: "2026-08-14",
          daemonSupportedProtocols: ["2026-04-30"],
          reason: "version.ceiling_exceeded",
        },
      }),
    ).toBe(false);
  });
});

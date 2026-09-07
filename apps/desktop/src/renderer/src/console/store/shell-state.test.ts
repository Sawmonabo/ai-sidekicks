// What the shell reported, and whether two reports say the same thing.
//
// The vocabulary half. What a reported condition COSTS a control is asserted beside
// this in `shell-mutation-block.test.ts`, against the module that derives it.

import { describe, expect, it } from "vitest";

import { describeShellConnection, shellReportsAreEqual, type ShellReport } from "./shell-state.js";
import { REPORTED_CONNECTIONS } from "./shell-state.test-support.js";

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
